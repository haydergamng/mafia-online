const {app,BrowserWindow,shell}=require('electron');
const path=require('node:path');
const URL='https://mafia-online-kfu6.onrender.com/';
app.setName('ليلة المافيا');
app.whenReady().then(()=>{
 const win=new BrowserWindow({title:'ليلة المافيا | Mafia Online',icon:path.join(__dirname,'icon.ico'),width:1100,height:780,minWidth:420,minHeight:600,autoHideMenuBar:true,
 webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true}});
 win.loadURL(URL);
 win.webContents.setWindowOpenHandler(({url})=>{
   if(url.startsWith('https://')) shell.openExternal(url);
   return {action:'deny'};
 });
});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
