import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { SMOOTHING, smoothFrame } from '../src/qr-smooth';

// A synthetic prescription QR (version 10, 57 modules a side, placeholder fields only), one row of modules per hex number.
const ROWS = [
  '1fcff9987e55e7f', '104591e96266241', '1759c496684865d', '174b02022eaf25d', '174d56d7f8f525d', '1044878c6ba7c41',
  '1fd55555555557f', '001c2d2c4a4a500', '1df55b5fde1e0c4', '0b0c1a1e8b4b6a8', '19d3878bde5e715', '1d37d2d96ec7b18',
  '0457b5a92135259', '172280af7a96a2e', '0cd1a6d96901a57', '1f24fdb29099baa', '067ca66e5755be9', '1028a66ba0a92b5',
  '1ee45dfe97987e9', '0a3003a8db51289', '03db57dd9d9c57b', '1d831694ab8b095', '164f47819c9b681', '17a912d664a4a97',
  '0f5a75b721e1e97', '1e2ca1a874b4a0a', '17fc7877e5e5ff6', '1d1eed244eddf1b', '1356a965591595a', '1917a82c49adb1c',
  '0ff2b20fd830bff', '08acea6e9a990a9', '03e826655b55de0', '1a08266802a8a2d', '05c947f3779b9d9', '0a3a2a2217ef32a',
  '04ed75fb51bafb9', '1810252207919eb', '0dc5b8734484bbc', '001a6d2a4a4a7aa', '13ec5b555e1e16d', '069b9a1d0b4b7a8',
  '0adb87845e5e455', '1b9792dd69ed878', '0dffe5a7653d4e9', '108020ac3a8da29', '14ee616e6801879', '1f03f4b724d9072',
  '00742e6ffb959f7', '0019ea6461aab19', '1fdec57d7498951', '105fee4c5b99b1b', '175897d7dd115f9', '174256164bb2896',
  '175007870cb7991', '105e92d164a4826', '1fd275b461e1dd7',
].map(row => BigInt(`0x${row}`).toString(2).padStart(57, '0'));
const TEXT = '0000000000;2;04;測試;A1********;0990101;AB;1151104;0018;28;B24;R0789#I10#E119#E785;0000000000;;TESTCODE01;1;QD;PO;28;TESTCODE02;1;QD;PO;28;TESTCODE03;0.5;BID;PO;28;';
assert.equal(ROWS.length, 57);

/** The QR drawn scale pixels a module with 4 modules of quiet zone; spread makes every pixel a checkerboard dot, as halftone does. */
function draw(scale: number, dark: number, light: number, spread: number) {
  const size = (ROWS.length + 8) * scale, data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const on = ROWS[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4] === '1';
    const p = (y * size + x) * 4;
    data[p] = data[p + 1] = data[p + 2] = (on ? dark : light) + ((x + y) % 2 ? spread : -spread);
    data[p + 3] = 255;
  }
  return { data, size };
}
const read = (data: Uint8ClampedArray, size: number) => {
  const code = jsQR(data, size, size, { inversionAttempts: 'dontInvert' });
  return code && new TextDecoder().decode(Uint8Array.from(code.binaryData));
};

// Printed solid, the frame reads as it is, and blurring does not lose it.
let qr = draw(9, 30, 230, 0);
assert.equal(read(qr.data, qr.size), TEXT);
for (const radius of [1, 2, 3]) assert.equal(read(smoothFrame(qr.data, qr.size, qr.size, radius), qr.size), TEXT, `solid r${radius}`);
// Printed in halftone on grainy paper, as the prescription in question: specks that jsQR cannot read until blurred. Which radius
// merges the dots depends on their size in the frame, so the camera tries each; at every distance here one of them reads it.
for (const [scale, dark, light, spread] of [[8, 90, 170, 80], [9, 90, 170, 80], [9, 100, 180, 90], [12, 90, 170, 80], [9, 60, 200, 60]]) {
  qr = draw(scale, dark, light, spread);
  assert.equal(read(qr.data, qr.size), null, `halftone ${scale} px a module reads only when blurred`);
  const radii = SMOOTHING.filter(radius => radius && read(smoothFrame(qr.data, qr.size, qr.size, radius), qr.size) === TEXT);
  assert.ok(radii.length, `halftone ${scale} px a module: no radius in SMOOTHING reads it`);
}
// The plain frame comes first, then each radius once.
assert.equal(SMOOTHING[0], 0);
assert.equal(new Set(SMOOTHING).size, SMOOTHING.length);

// The blur: grey levels averaged over 2r + 1 pixels across, then down, edges repeating their last pixel; alpha opaque.
const flat = new Uint8ClampedArray(4 * 4 * 4).fill(100);
assert.deepEqual([...smoothFrame(flat, 4, 4, 2)], Array.from({ length: 16 }, () => [100, 100, 100, 255]).flat());
const line = new Uint8ClampedArray(5 * 4);
line.set([255, 255, 255, 255], 8); // one white pixel in the middle of five black ones
assert.deepEqual([...smoothFrame(line, 5, 1, 1)].filter((_, i) => i % 4 === 0), [0, 85, 85, 85, 0]);
console.log('qr smoothing for halftone prints passed');
