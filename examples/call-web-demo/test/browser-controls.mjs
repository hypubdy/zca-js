// Uses Chrome's fake microphone; never opens the physical microphone or places a call.
import { chromium } from 'playwright-core';
import assert from 'node:assert/strict';
const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--autoplay-policy=no-user-gesture-required','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']});
const page = await browser.newPage();
try {
    await page.goto(process.env.DEMO_URL || 'http://localhost:4317');
    await page.getByText('Đã kết nối backend.',{exact:true}).waitFor();
    await page.getByTestId('mode-echo').click();
    await page.getByTestId('source-mic').click();
    await page.getByTestId('start').click();
    await page.waitForFunction(()=>window.__callDemoLevels?.receive > .001,null,{timeout:20000});
    await page.getByRole('button',{name:'Tắt mic',exact:true}).click();
    await page.waitForFunction(()=>window.__callDemoAudioState?.().micEnabled?.every(value=>!value));
    await page.getByRole('button',{name:'Bật mic',exact:true}).click();
    await page.waitForFunction(()=>window.__callDemoAudioState?.().micEnabled?.every(Boolean));
    await page.getByRole('button',{name:'Tắt loa',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Bật loa',exact:true}).count(),1);
    await page.getByTestId('stop').click();
    await page.waitForFunction(()=>window.__callDemoAudioState?.().localTracks?.every(state=>state==='ended'));
    await page.getByTestId('mode-zalo').click();
    assert.equal(await page.getByTestId('stop').innerText(),'Kết thúc cuộc gọi');
    console.log(JSON.stringify({passed:true,micMute:true,micUnmute:true,speakerMute:true,cleanup:true,realZaloCall:false}));
} catch (error) {
    console.error(JSON.stringify({error:error.message,ui:(await page.locator('body').innerText()).slice(-2200),stats:await page.evaluate(()=>window.__callDemoStats)}));
    throw error;
} finally {await browser.close();}
