/**
 * Inspection Report Builder — Google Sheets backend
 *
 * SETUP
 * 1. Open the Google Sheet this is meant for: "Inspection Report Builder — Customer Database"
 * 2. Extensions > Apps Script
 * 3. Delete any starter code in Code.gs, paste this whole file in, save.
 * 4. Deploy > New deployment > select type "Web app"
 *      - Execute as: Me
 *      - Who has access: Anyone (or "Anyone within [your org]" if you're on Workspace)
 * 5. Copy the Web app URL (ends in /exec) and paste it into the Customers tab
 *    of the Inspection Report Builder tool (or hardcode it into DEFAULT_APPS_SCRIPT_URL
 *    near the top of that tool's <script> so it connects automatically).
 *
 * UPDATING AN EXISTING DEPLOYMENT
 * If you've already deployed this once and are pasting in a newer version (like this
 * one, which adds JobTickets), pasting the code alone is not enough — Web App
 * deployments are pinned to a specific saved version. After pasting and saving:
 *   Deploy > Manage deployments > (pencil/edit icon on your existing deployment)
 *   > Version: "New version" > Deploy.
 * That keeps the same /exec URL (so nothing needs re-pasting into the tool) while
 * pushing this updated code live. New sheets/columns are created automatically
 * the next time the script runs — no manual sheet editing needed either way.
 *
 * Six tabs and their headers are created automatically (ensureSheets()), and any
 * columns added to SCHEMAS below get appended to existing sheets' header rows too.
 */

const SCHEMAS = {
  BillingLocations: ['id','name','address','cityState','phone','email','notes','createdAt'],
  ServiceLocations: ['id','billingId','name','address','cityState','contactName','contactPhone','notes','createdAt'],
  Notes:            ['id','serviceId','text','addedAt'],
  Attachments:      ['id','serviceId','name','mimeType','driveFileUrl','addedAt'],
  JobTickets:       ['id','serviceId','jobDate','jobType','status','assignedTo','description','createdAt'],
  ReportTypes:      ['id','name','slug','schemaJson','createdAt'],
  Reports:          ['id','serviceId','jobTicketId','reportType','buildingName','inspType','inspDate','savedAt','dataJson']
};

function ensureSheets(){
  // Fast path: skip the full 6-sheet migration check on every request — only
  // re-verify when the schema itself changes, or at most once every 6 hours.
  // This is the single biggest latency cost per call, so caching it matters.
  const cache = CacheService.getScriptCache();
  const schemaSig = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(SCHEMAS))
  );
  if(cache.get('sheets_ensured_sig') === schemaSig) return;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SCHEMAS).forEach(name=>{
    let sh = ss.getSheetByName(name);
    if(!sh){
      sh = ss.insertSheet(name);
      sh.appendRow(SCHEMAS[name]);
      sh.setFrozenRows(1);
    } else {
      // migrate: append any columns this schema has that the sheet doesn't yet
      const lastCol = Math.max(sh.getLastColumn(), 1);
      const existingHeaders = sh.getRange(1,1,1,lastCol).getValues()[0];
      const missing = SCHEMAS[name].filter(h => existingHeaders.indexOf(h) === -1);
      if(missing.length){
        sh.getRange(1, existingHeaders.length + 1, 1, missing.length).setValues([missing]);
      }
    }
  });
  cache.put('sheets_ensured_sig', schemaSig, 21600);
  const def = ss.getSheetByName('Sheet1');
  if(def && ss.getSheets().length > 1 && def.getLastRow() === 0){
    ss.deleteSheet(def);
  }
}

function getSheetData_(sheetName){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if(!sh) return [];
  const values = sh.getDataRange().getValues();
  const headers = values.shift();
  return values
    .filter(row => row.some(cell => cell !== ''))
    .map(row => {
      const obj = {};
      headers.forEach((h,i) => obj[h] = row[i]);
      return obj;
    });
}

function findRowIndexById_(sh, id){
  const values = sh.getDataRange().getValues();
  for(let i=1;i<values.length;i++){
    if(String(values[i][0]) === String(id)) return i+1; // 1-indexed sheet row
  }
  return -1;
}

function getOrCreateAttachmentsFolder_(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ssFile = DriveApp.getFileById(ss.getId());
  const parents = ssFile.getParents();
  const parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  const folderName = 'Inspection Report Builder - Attachments';
  const existing = parent.getFoldersByName(folderName);
  if(existing.hasNext()) return existing.next();
  return parent.createFolder(folderName);
}

function jsonOut_(obj){
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e){
  try{
    ensureSheets();
    const action = e.parameter.action;
    const sheetName = e.parameter.sheet;

    if(action === 'list'){
      let rows = getSheetData_(sheetName);
      if(e.parameter.billingId) rows = rows.filter(r => String(r.billingId) === String(e.parameter.billingId));
      if(e.parameter.serviceId) rows = rows.filter(r => String(r.serviceId) === String(e.parameter.serviceId));
      return jsonOut_({ok:true, rows});
    }
    if(action === 'get'){
      const rows = getSheetData_(sheetName);
      const row = rows.find(r => String(r.id) === String(e.parameter.id));
      return jsonOut_({ok:true, row: row || null});
    }
    if(action === 'search'){
      const q = (e.parameter.q || '').toLowerCase();
      const billing = getSheetData_('BillingLocations').filter(r =>
        !q || String(r.name).toLowerCase().includes(q) || String(r.cityState).toLowerCase().includes(q));
      const services = getSheetData_('ServiceLocations').filter(r =>
        !q || String(r.name).toLowerCase().includes(q) || String(r.cityState).toLowerCase().includes(q));
      return jsonOut_({ok:true, billing, services});
    }
    return jsonOut_({ok:false, error:'Unknown action: ' + action});
  } catch(err){
    return jsonOut_({ok:false, error:String(err)});
  }
}

function doPost(e){
  try{
    ensureSheets();
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    if(action === 'uploadAttachment'){
      const folder = getOrCreateAttachmentsFolder_();
      const bytes = Utilities.base64Decode(body.data.base64);
      const blob = Utilities.newBlob(bytes, body.data.mimeType || 'application/octet-stream', body.data.name || 'attachment');
      const file = folder.createFile(blob);
      try{ file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch(shareErr){ /* org policy may block this — file still saved */ }
      const id = Utilities.getUuid();
      const shAtt = ss.getSheetByName('Attachments');
      const headers = shAtt.getRange(1,1,1,shAtt.getLastColumn()).getValues()[0];
      const rec = {
        id, serviceId: body.data.serviceId, name: body.data.name,
        mimeType: body.data.mimeType, driveFileUrl: file.getUrl(),
        addedAt: new Date().toISOString()
      };
      shAtt.appendRow(headers.map(h => rec[h] !== undefined ? rec[h] : ''));
      return jsonOut_({ok:true, id, url: file.getUrl()});
    }

    const sheetName = body.sheet;
    const sh = ss.getSheetByName(sheetName);
    if(!sh) return jsonOut_({ok:false, error:'Unknown sheet: ' + sheetName});
    const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];

    if(action === 'create'){
      const id = body.id || Utilities.getUuid();
      const data = Object.assign({}, body.data, {id});
      if(headers.indexOf('createdAt') > -1 && !data.createdAt) data.createdAt = new Date().toISOString();
      if(headers.indexOf('savedAt') > -1 && !data.savedAt) data.savedAt = new Date().toISOString();
      if(headers.indexOf('addedAt') > -1 && !data.addedAt) data.addedAt = new Date().toISOString();
      const row = headers.map(h => data[h] !== undefined ? data[h] : '');
      sh.appendRow(row);
      return jsonOut_({ok:true, id});
    }
    if(action === 'update'){
      const rowIdx = findRowIndexById_(sh, body.id);
      if(rowIdx === -1) return jsonOut_({ok:false, error:'Row not found'});
      const current = {};
      const values = sh.getRange(rowIdx,1,1,headers.length).getValues()[0];
      headers.forEach((h,i) => current[h] = values[i]);
      const merged = Object.assign(current, body.data, {id: body.id});
      const row = headers.map(h => merged[h] !== undefined ? merged[h] : '');
      sh.getRange(rowIdx,1,1,headers.length).setValues([row]);
      return jsonOut_({ok:true});
    }
    if(action === 'delete'){
      const rowIdx = findRowIndexById_(sh, body.id);
      if(rowIdx === -1) return jsonOut_({ok:false, error:'Row not found'});
      sh.deleteRow(rowIdx);
      return jsonOut_({ok:true});
    }
    return jsonOut_({ok:false, error:'Unknown action: ' + action});
  } catch(err){
    return jsonOut_({ok:false, error:String(err)});
  }
}
