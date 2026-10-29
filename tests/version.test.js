'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
test('إصدار v1.4 ظاهر في جميع المواضع',()=>{
 const root=path.join(__dirname,'..');
 const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
 const html=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
 const app=fs.readFileSync(path.join(root,'public/app.js'),'utf8');
 assert.equal(pkg.version,'1.4.0');
 assert.match(html,/v1\.4/);
 assert.match(app,/v1\.4/);
});
