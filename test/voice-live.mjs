import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createDevelopmentServer } from '../server/dev.mjs';
import { createMiniMaxSpeechTransport, speechConnectionFromEnvironment } from '../server/speech.mjs';
import { createConnection, PLUGIN_VERSION } from '../dist/core.js';

if (!process.env.MINIMAX_SPEECH_API_KEY || !process.env.DEEPSEEK_API_KEY) throw new Error('MINIMAX_SPEECH_API_KEY and DEEPSEEK_API_KEY required');
const speech = createMiniMaxSpeechTransport(speechConnectionFromEnvironment());
const chunks = [];
const synthesis = speech.synthesize({ turn_id: 'synthetic-input', voice_id: 'male-qn-qingse', language: 'zh', sample_rate: 16000, onAudio(bytes) { chunks.push(Buffer.from(bytes)); } });
synthesis.write('今天心情很好。'); await synthesis.flush();
const pcm = Buffer.concat(chunks); assert.ok(pcm.length > 0);
const wave = Buffer.alloc(44 + pcm.length); wave.write('RIFF'); wave.writeUInt32LE(wave.length-8,4); wave.write('WAVEfmt ',8); wave.writeUInt32LE(16,16); wave.writeUInt16LE(1,20); wave.writeUInt16LE(1,22); wave.writeUInt32LE(16000,24); wave.writeUInt32LE(32000,28); wave.writeUInt16LE(2,32); wave.writeUInt16LE(16,34); wave.write('data',36); wave.writeUInt32LE(pcm.length,40); pcm.copy(wave,44);
const server = createDevelopmentServer({ connection: createConnection('deepseek', { apiKey: process.env.DEEPSEEK_API_KEY }) });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
let executablePath;
for (const candidate of [process.env.PLAYWRIGHT_BROWSER_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean)) { try { await access(candidate); executablePath=candidate; break; } catch {} }
const browser = await chromium.launch({ headless:true, args:['--autoplay-policy=no-user-gesture-required'], ...(executablePath ? { executablePath } : {}) });
const page = await browser.newPage(); page.setDefaultTimeout(180000);
const report = { version: PLUGIN_VERSION, checkedAt: new Date().toISOString(), synthetic_input: true, physical_microphone: 'unverified', audible_playback: 'unverified', checks: [] };
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/examples/test.html`);
  await page.evaluate(() => {
    window.voiceEvents=[];
    const api=JsPsychAI; const client=api.createAIClient({ transport:api.createProxyTransport(),timeoutMs:300000 });
    const jsPsych=initJsPsych({ display_element:'experiment',on_finish() { window.voiceData=jsPsych.data.get().values()[0]; } });
    jsPsych.run([api.createAITrial('chat',{ client, prompt:'用中文提供具体的学习建议，称呼参与者为你。每次回答80字，保留完整句子。', research:{group:'multimodal',materials:[]},
      speech:{enabled:true,input_mode:'file',output:true,review_transcript:true,save_audio:true}, on_event(event) { window.voiceEvents.push(event); },
      persist_media(blob,reference) { return { url:`memory:${reference.id}`,filename:'synthetic.wav' }; } })]);
  });
  await page.getByLabel('转录音频文件').setInputFiles({ name:'synthetic.wav',mimeType:'audio/wav',buffer:wave });
  await page.getByLabel('确认转录').waitFor(); const transcript=await page.getByLabel('确认转录').inputValue(); assert.ok(transcript.includes('心情'));
  report.checks.push({name:'real_asr_through_browser_proxy',ok:true,transcript});
  await page.getByLabel('确认转录').fill('今天心情很好，请给我一个学习建议。'); await page.getByRole('button',{name:'确认并发送',exact:true}).click();
  await page.waitForFunction(()=>window.voiceEvents.some(event=>event.type==='speech_playback_start'));
  await page.getByRole('button',{name:'打断播报',exact:true}).click();
  await page.waitForFunction(()=>document.querySelector('.ai-research')?.getAttribute('aria-busy')==='false');
  report.checks.push({name:'real_tts_pcm_playback_and_local_interrupt',ok:true});
  await page.getByLabel('你的回答',{exact:true}).fill('换一个建议，控制在25字。'); await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForFunction(()=>window.voiceEvents.filter(event=>event.type==='speech_playback_end').length>=1);
  await page.waitForFunction(()=>document.querySelector('.ai-research')?.getAttribute('aria-busy')==='false');
  await page.getByRole('button',{name:'完成',exact:true}).click(); await page.waitForFunction(()=>window.voiceData);
  const data=await page.evaluate(()=>window.voiceData); report.trial=data;
  assert.equal(data.ai_status,'complete'); assert.equal(data.speech_turns[0].corrected,true); assert.equal(data.media[0].status,'saved');
  assert.ok(data.speech_playback.some(output=>output.interruption==='button')); assert.ok(data.speech_playback.some(output=>output.status==='complete'&&output.playback_ended_ms));
  assert.deepEqual(errors,[]); report.checks.push({name:'second_turn_after_interrupt_and_exported_timing',ok:true});
  report.ok=true;
} catch(error) { report.ok=false; report.error=String(error.stack); report.pageErrors=errors; }
finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
await mkdir('artifacts',{recursive:true}); await writeFile('artifacts/voice-live-v0.3.json',JSON.stringify(report,null,2));
console.log(JSON.stringify({ok:report.ok,checks:report.checks,error:report.error,speech_turns:report.trial?.speech_turns,speech_playback:report.trial?.speech_playback},null,2));
if(!report.ok) process.exitCode=1;
