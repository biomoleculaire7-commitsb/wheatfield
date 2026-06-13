
const express=require('express'),multer=require('multer'),fetch=require('node-fetch'),FormData=require('form-data'),cors=require('cors'),path=require('path');
const app=express(),upload=multer({storage:multer.memoryStorage()});
const BAND_KEY='band_a_1780742646_tSsWs9F10mNPRp-4SuHJkrsyB1jK0Y4R4';
const BAND_URL='https://band.ai/api/v1/agents/run';
app.use(cors());app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
let latest=null;
app.get('/health',(req,res)=>res.json({status:'WheatField online',hasData:!!latest}));
app.get('/drone/latest',(req,res)=>latest?res.json(latest):res.status(404).json({error:'No drone data yet'}));
app.post('/proxy',upload.any(),async(req,res)=>{
  try{
    const ctx=JSON.parse(req.body.context||'{}');
    const images=(req.files||[]).map((f,i)=>({spot:ctx.spots?.[i]?.spot||`Zone ${String.fromCharCode(65+i)}`,base64:`data:${f.mimetype};base64,${f.buffer.toString('base64')}`}));
    latest={source:ctx.source||'WheatField',image_count:images.length,spots:ctx.spots||[],telemetry:ctx.telemetry||{},images,timestamp:Date.now()};
    console.log(`Saved ${images.length} images`);
    res.json({status:'received',image_count:images.length,agent4_output:'Router: data received',agent5_output:'Analyzer: ready for YOLOv8',agent6_output:'Reporter: check /drone/latest',timestamp:Date.now()});
    const form=new FormData();
    (req.files||[]).forEach(f=>form.append(f.fieldname,f.buffer,{filename:f.originalname||`${f.fieldname}.jpg`,contentType:f.mimetype||'image/jpeg'}));
    form.append('context',req.body.context);
    fetch(BAND_URL,{method:'POST',headers:{'Authorization':`Bearer ${BAND_KEY}`,...form.getHeaders()},body:form}).catch(e=>console.error('Band error:',e.message));
  }catch(err){res.status(500).json({error:err.message})}
});
const PORT=process.env.PORT||3001;
app.listen(PORT,()=>console.log(`Running on ${PORT}`));
module.exports=app;
