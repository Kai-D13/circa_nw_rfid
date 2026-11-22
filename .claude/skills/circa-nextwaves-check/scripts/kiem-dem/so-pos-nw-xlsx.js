// CHỈ ĐỌC, offline. Từ out/so-pos-nw.json → xlsx theo sản phẩm. Dùng: node so-pos-nw-xlsx.js <so-pos-nw.json> <out.xlsx>
const fs=require("fs"),path=require("path");
const {XLSX}=require(path.resolve(".claude/skills/circa-nextwaves-check/scripts/kiem-dem/load-tool.js"));
const {rows}=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const kl=r=>{
  const sc=(r.cntC||0)>0, c=r.cntC;
  if(r.pos===null)return ["Chỉ có trên NW","Kiểm vì sao POS không có dòng (hết tồn / không thuộc phiên)"];
  if(r.nw===null)return ["Chỉ có trên POS","Hàng chưa gắn thẻ RFID / chưa nhập NW"];
  if(!sc){ if(r.pos===r.nw)return ["Chưa quét · POS = NW",""]; return [r.pos<r.nw?"Chưa quét · NW cao hơn POS":"Chưa quét · POS cao hơn NW","Chờ quét mới kết luận"]; }
  if(c===r.pos&&c===r.nw)return ["1. Khớp cả ba",""];
  if(r.pos===r.nw)return ["2. POS = NW, quét chưa đủ","Quét tiếp các thẻ còn lại"];
  if(c===r.pos&&c<r.nw)return ["3. Quét = POS, NW cao hơn","NW còn thẻ của hàng đã bán/chuyển chưa trừ → trừ trên NW"];
  if(c===r.nw&&c>r.pos)return ["4. Quét = NW, POS thấp hơn","Hàng có thật nhiều hơn POS → điều chỉnh POS"];
  if(c===r.nw&&c<r.pos)return ["5. Quét hết thẻ NW, POS cao hơn","Hàng chưa gắn thẻ, hoặc POS cao → đếm tay"];
  if(c>r.pos)return ["6. Quét nhiều hơn POS, chưa hết thẻ NW","POS thấp; quét tiếp"];
  return ["7. Quét thiếu so với cả POS và NW (POS ≠ NW)","Quét tiếp rồi mới kết luận"];
};
const out=rows.map(r=>{const [k,v]=kl(r);return {"Mã SP":Number(r.p),"Tên sản phẩm":r.name,"Đơn vị":r.unitC||r.unitN,"Tồn POS (SL dự kiến)":r.pos,"POS kho thất lạc":r.miss,"Tồn NW":r.nw,"POS − NW":r.pos===null||r.nw===null?"":r.pos-r.nw,"Đã quét":r.cntC??r.cntN,"Quét − POS":r.pos===null?"":(r.cntC||0)-r.pos,"Quét − NW":r.nw===null?"":(r.cntC||0)-r.nw,"Nhóm":k,"Việc cần làm":v};})
 .sort((a,b)=>String(a["Nhóm"]).localeCompare(String(b["Nhóm"]))||Math.abs(b["POS − NW"]||0)-Math.abs(a["POS − NW"]||0));
const cnt={};out.forEach(r=>{const o=cnt[r["Nhóm"]]||(cnt[r["Nhóm"]]={"Nhóm":r["Nhóm"],"Số SP":0,"Tồn POS":0,"Tồn NW":0,"Đã quét":0});o["Số SP"]++;o["Tồn POS"]+=r["Tồn POS (SL dự kiến)"]||0;o["Tồn NW"]+=r["Tồn NW"]||0;o["Đã quét"]+=r["Đã quét"]||0;});
const wb=XLSX.utils.book_new();
const sh=(n,a,w)=>{const s=XLSX.utils.json_to_sheet(a);s["!cols"]=w.map(x=>({wch:x}));XLSX.utils.book_append_sheet(wb,s,n);};
sh("Tổng hợp nhóm",Object.values(cnt).sort((a,b)=>a["Nhóm"].localeCompare(b["Nhóm"])),[48,8,10,10,10]);
const W=[10,60,8,12,10,10,10,10,10,10,44,56];
sh("SP đã quét (279)",out.filter(r=>/^\d\./.test(r["Nhóm"])),W);
sh("SP chưa quét",out.filter(r=>!/^\d\./.test(r["Nhóm"])),W);
fs.writeFileSync(process.argv[3],Buffer.from(XLSX.write(wb,{type:"array",bookType:"xlsx"})));
console.table(Object.values(cnt).sort((a,b)=>a["Nhóm"].localeCompare(b["Nhóm"])));
for(const g of ["3.","4.","5.","6."]){console.log(g);out.filter(r=>r["Nhóm"].startsWith(g)).slice(0,30).forEach(r=>console.log(" ",r["Mã SP"],r["Tên sản phẩm"].slice(0,45),"|",r["Đơn vị"],"POS",r["Tồn POS (SL dự kiến)"],"NW",r["Tồn NW"],"quét",r["Đã quét"]));}
