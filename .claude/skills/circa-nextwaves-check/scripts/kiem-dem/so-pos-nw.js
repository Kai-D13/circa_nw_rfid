// CHỈ ĐỌC, offline. So tồn POS (SL dự kiến phiên Circa) với tồn NW (Tồn hệ thống phiên kiểm kê NW) theo product_id.
// Dùng: node so-pos-nw.js <kiem-ke-ICS.xlsx> <kiem-ke-nw.xlsx> <out.json>
const fs=require("fs"),path=require("path");
const {XLSX}=require(path.resolve(".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
const [, , FC, FN, OUT]=process.argv;
const rd=(f,s)=>XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(f),{type:"buffer"}).Sheets[s],{defval:""});
const n=v=>{let s=String(v).trim();if(/^\d{1,3}(\.\d{3})+$/.test(s))s=s.replace(/\./g,"");else if(/[.,]/.test(s))throw new Error("số có dấu lạ "+v);const x=Number(s);if(!isFinite(x))throw new Error("số lạ "+v);return x;};
const C={},N={};let dupC=0,dupN=0;
for(const r of rd(FC,"Danh sách kiểm kê")){const p=String(r["Mã sản phẩm"]);if(C[p])dupC++;const o=C[p]||(C[p]={p,name:r["Tên sản phẩm"],unit:r["Đơn vị"],exp:0,main:0,inb:0,miss:0,cnt:0,rows:0});
  o.exp+=n(r["SL dự kiến"]);o.main+=n(r["SL kệ chính"]);o.inb+=n(r["SL kho inbound"]);o.miss+=n(r["SL kho missing"]);o.cnt+=n(r["SL đã đếm"]);o.rows++;}
for(const r of rd(FN,"Danh sách kiểm kê")){const p=String(r["Mã SP"]).replace(/^CIRCA-/,"");if(N[p])dupN++;const o=N[p]||(N[p]={p,name:r["Tên sản phẩm"],unit:r["ĐVT"],sys:0,cnt:0});o.sys+=n(r["Tồn hệ thống"]);o.cnt+=n(r["Đã đếm"]);}
const all=[...new Set([...Object.keys(C),...Object.keys(N)])];
const rows=all.map(p=>{const c=C[p],w=N[p];return {p,name:(c||w).name,unitC:c&&c.unit,unitN:w&&w.unit,pos:c?c.exp:null,miss:c?c.miss:null,nw:w?w.sys:null,cntC:c?c.cnt:null,cntN:w?w.cnt:null};});
const g={};const add=(k,r)=>(g[k]||(g[k]=[])).push(r);
for(const r of rows){
  if(r.pos===null)add("chi-NW",r);else if(r.nw===null)add("chi-POS",r);
  else if(r.unitC.toLowerCase()!==r.unitN.toLowerCase())add("khac-don-vi",r);
  else if(r.pos===r.nw)add("bang",r);else if(r.pos>r.nw)add("POS>NW",r);else add("POS<NW",r);
}
console.log("Circa dòng",Object.keys(C).length,"trùng pid",dupC,"| NW",Object.keys(N).length,"trùng",dupN);
const S=(a,f)=>a.reduce((x,r)=>x+(f(r)||0),0);
for(const k in g)console.log(k,g[k].length,"| POS",S(g[k],r=>r.pos),"NW",S(g[k],r=>r.nw),"| có quét",g[k].filter(r=>r.cntC>0||r.cntN>0).length);
console.log("tổng POS",S(rows,r=>r.pos),"tổng NW",S(rows,r=>r.nw),"đếm Circa",S(rows,r=>r.cntC),"đếm NW",S(rows,r=>r.cntN));
// 279 SP đã quét
const sc=rows.filter(r=>r.cntC>0||r.cntN>0);
console.log("SP đã quét",sc.length,"| đếm Circa≠đếm NW:",sc.filter(r=>r.cntC!==r.cntN).length);
const h={};
for(const r of sc){
  const a=r.cntC===r.pos?"=POS":r.cntC>r.pos?">POS":"<POS", b=r.nw===null?"?NW":r.cntC===r.nw?"=NW":r.cntC>r.nw?">NW":"<NW";
  const k=a+" "+b+" | "+(r.nw===null?"-":r.pos===r.nw?"POS=NW":r.pos>r.nw?"POS>NW":"POS<NW");r.k=k;(h[k]||(h[k]=[])).push(r);
}
for(const k of Object.keys(h).sort())console.log(k.padEnd(28),h[k].length,"| vd:",h[k].sort((x,y)=>Math.abs(y.pos-y.nw)-Math.abs(x.pos-x.nw)).slice(0,3).map(r=>`${r.p} pos${r.pos} nw${r.nw} đếm${r.cntC}`).join("; "));
fs.writeFileSync(OUT,JSON.stringify({rows,groups:Object.fromEntries(Object.entries(g).map(([k,v])=>[k,v.length]))}));
for(const k of ["POS>NW","POS<NW","chi-POS","chi-NW","khac-don-vi"]){console.log("\nTOP",k);(g[k]||[]).sort((x,y)=>Math.abs((y.pos||0)-(y.nw||0))-Math.abs((x.pos||0)-(x.nw||0))).slice(0,8).forEach(r=>console.log(" ",r.p,String(r.name).slice(0,50),"|",r.unitC||"",r.unitN||"","| POS",r.pos,"miss",r.miss,"NW",r.nw,"đếm",r.cntC,r.cntN));}
