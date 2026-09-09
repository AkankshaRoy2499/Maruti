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
 * If you've already deployed this once and are pasting in a newer version, pasting the
 * code alone is not enough — Web App deployments are pinned to a specific saved version.
 * After pasting and saving:
 *   Deploy > Manage deployments > (pencil/edit icon on your existing deployment)
 *   > Version: "New version" > Deploy.
 * That keeps the same /exec URL (so nothing needs re-pasting into the tool) while
 * pushing this updated code live. New sheets/columns are created automatically
 * the next time the script runs — no manual sheet editing needed either way.
 *
 * LOGIN
 * The app is now gated behind a login screen. A master admin account is auto-created
 * the first time this script runs (see MASTER_EMAIL / MASTER_PASSWORD below — the email
 * is exactly what was requested when this was set up; edit the constant here and
 * redeploy a "New version" if it was meant to be something else, then re-run once so
 * the Users sheet re-seeds — it only seeds when the Users sheet is empty). The master
 * admin can create additional users from the app's Admin panel.
 *
 * NOTE: passwords are currently stored in PLAIN TEXT in the Users sheet (by request,
 * so an admin can open the sheet and read/manage them directly) — anyone with edit
 * access to the Sheet, or an admin login to the app, can see every password. Tighten
 * this later by hashing (see git history for a SHA-256 version) if that stops being OK.
 */

const SCHEMAS = {
  BillingLocations: ['id','name','address','cityState','phone','email','notes','createdAt'],
  ServiceLocations: ['id','billingId','name','address','cityState','contactName','contactPhone','notes','createdAt'],
  Notes:            ['id','serviceId','text','addedAt'],
  Attachments:      ['id','serviceId','name','mimeType','driveFileUrl','addedAt'],
  JobTickets:       ['id','ticketNo','serviceId','jobDate','jobType','status','assignedTo','description','createdAt'],
  ReportTypes:      ['id','name','slug','schemaJson','createdAt'],
  Reports:          ['id','serviceId','jobTicketId','reportType','buildingName','inspType','inspDate','savedAt','dataJson'],
  Users:            ['id','email','password','role','createdAt'],
  Sessions:         ['id','userId','email','role','createdAt','expiresAt']
};

// Master admin — seeded once into the Users sheet the first time it's empty.
const MASTER_EMAIL = 'support@maruti@zentrades.pro';
const MASTER_PASSWORD = 'Admin@123';
const SESSION_HOURS = 12;

function ensureSheets(){
  // Fast path: skip the full sheet migration check on every request — only
  // re-verify when the schema itself changes, or at most once every 6 hours.
  // This is the single biggest latency cost per call, so caching it matters.
  const cache = CacheService.getScriptCache();
  const schemaSig = Utilities.base64Encode(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(SCHEMAS))
  );
  if(cache.get('sheets_ensured_sig') === schemaSig){
    seedMasterAdminIfNeeded_();
    return;
  }

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
  seedMasterAdminIfNeeded_();
}

function seedMasterAdminIfNeeded_(){
  const rows = getSheetData_('Users');
  if(rows.length) return;
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Users');
  sh.appendRow([Utilities.getUuid(), MASTER_EMAIL, MASTER_PASSWORD, 'admin', new Date().toISOString()]);
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

/* ============================= AUTH ============================= */

function makeSession_(user){
  const token = Utilities.getUuid();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sessions');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_HOURS*3600*1000);
  sh.appendRow([token, user.id, user.email, user.role, now.toISOString(), expires.toISOString()]);
  return {token, expiresAt: expires.toISOString()};
}

function getSession_(token){
  if(!token) return null;
  const rows = getSheetData_('Sessions');
  const row = rows.find(r => String(r.id) === String(token));
  if(!row) return null;
  if(new Date(row.expiresAt) < new Date()) return null;
  return row;
}

function cleanupExpiredSessions_(){
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Sessions');
  const values = sh.getDataRange().getValues();
  const headers = values[0];
  const expIdx = headers.indexOf('expiresAt');
  const now = new Date();
  for(let i=values.length-1;i>=1;i--){
    if(new Date(values[i][expIdx]) < now) sh.deleteRow(i+1);
  }
}

function nextTicketNo_(){
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try{
    const props = PropertiesService.getScriptProperties();
    const current = parseInt(props.getProperty('lastTicketNo') || '1000', 10);
    const next = current + 1;
    props.setProperty('lastTicketNo', String(next));
    return 'TCK-' + next;
  } finally {
    lock.releaseLock();
  }
}

/* ============================= HTTP ENTRY POINTS ============================= */

function doGet(e){
  try{
    ensureSheets();
    const action = e.parameter.action;
    const sheetName = e.parameter.sheet;

    const session = getSession_(e.parameter.token);
    if(!session) return jsonOut_({ok:false, error:'Not authenticated — please log in.', authRequired:true});
    if(sheetName === 'Users' && session.role !== 'admin'){
      return jsonOut_({ok:false, error:'Admin access required.'});
    }

    if(action === 'list'){
      let rows = getSheetData_(sheetName);
      if(e.parameter.billingId) rows = rows.filter(r => String(r.billingId) === String(e.parameter.billingId));
      if(e.parameter.serviceId) rows = rows.filter(r => String(r.serviceId) === String(e.parameter.serviceId));
      if(e.parameter.jobTicketId) rows = rows.filter(r => String(r.jobTicketId) === String(e.parameter.jobTicketId));
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

    if(action === 'login'){
      const email = String(body.email || '').trim();
      const password = String(body.password || '');
      const user = getSheetData_('Users').find(u => String(u.email).toLowerCase() === email.toLowerCase());
      if(!user || String(user.password) !== password){
        return jsonOut_({ok:false, error:'Incorrect email or password.'});
      }
      cleanupExpiredSessions_();
      const session = makeSession_(user);
      return jsonOut_({ok:true, token: session.token, expiresAt: session.expiresAt, user:{id:user.id, email:user.email, role:user.role}});
    }

    const session = getSession_(body.token);

    if(action === 'logout'){
      if(session){
        const shS = ss.getSheetByName('Sessions');
        const rowIdx = findRowIndexById_(shS, body.token);
        if(rowIdx > -1) shS.deleteRow(rowIdx);
      }
      return jsonOut_({ok:true});
    }
    if(!session) return jsonOut_({ok:false, error:'Not authenticated — please log in.', authRequired:true});

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
    if(sheetName === 'Users' && session.role !== 'admin'){
      return jsonOut_({ok:false, error:'Admin access required.'});
    }
    const sh = ss.getSheetByName(sheetName);
    if(!sh) return jsonOut_({ok:false, error:'Unknown sheet: ' + sheetName});
    const headers = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];

    if(action === 'create'){
      const id = body.id || Utilities.getUuid();
      const data = Object.assign({}, body.data, {id});
      if(sheetName === 'Users'){
        if(!data.email || !data.password) return jsonOut_({ok:false, error:'Email and password are required.'});
        const dupe = getSheetData_('Users').find(u => String(u.email).toLowerCase() === String(data.email).toLowerCase());
        if(dupe) return jsonOut_({ok:false, error:'A user with that email already exists.'});
        data.role = data.role === 'admin' ? 'admin' : 'user';
      }
      if(sheetName === 'JobTickets' && !data.ticketNo){
        data.ticketNo = nextTicketNo_();
      }
      if(headers.indexOf('createdAt') > -1 && !data.createdAt) data.createdAt = new Date().toISOString();
      if(headers.indexOf('savedAt') > -1 && !data.savedAt) data.savedAt = new Date().toISOString();
      if(headers.indexOf('addedAt') > -1 && !data.addedAt) data.addedAt = new Date().toISOString();
      const row = headers.map(h => data[h] !== undefined ? data[h] : '');
      sh.appendRow(row);
      return jsonOut_({ok:true, id, ticketNo: data.ticketNo});
    }
    if(action === 'update'){
      const rowIdx = findRowIndexById_(sh, body.id);
      if(rowIdx === -1) return jsonOut_({ok:false, error:'Row not found'});
      const current = {};
      const values = sh.getRange(rowIdx,1,1,headers.length).getValues()[0];
      headers.forEach((h,i) => current[h] = values[i]);
      const incoming = Object.assign({}, body.data);
      if(sheetName === 'Users'){
        if(!incoming.password) delete incoming.password; // don't blank out an existing password by accident
        if(incoming.role) incoming.role = incoming.role === 'admin' ? 'admin' : 'user';
      }
      const merged = Object.assign(current, incoming, {id: body.id});
      const row = headers.map(h => merged[h] !== undefined ? merged[h] : '');
      sh.getRange(rowIdx,1,1,headers.length).setValues([row]);
      return jsonOut_({ok:true});
    }
    if(action === 'delete'){
      if(sheetName === 'Users'){
        const target = getSheetData_('Users').find(u => String(u.id) === String(body.id));
        if(target && String(target.email).toLowerCase() === MASTER_EMAIL.toLowerCase()){
          return jsonOut_({ok:false, error:'The master admin account cannot be deleted.'});
        }
      }
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
