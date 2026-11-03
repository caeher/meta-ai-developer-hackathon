import assert from "node:assert/strict";
import fs from "node:fs";

const fixturePath = (name) => `tests/assets/preview/public/fixtures/${name}`;
const atlas = JSON.parse(fs.readFileSync(fixturePath("generated-spritesheet.json"), "utf8"));
const animation = JSON.parse(fs.readFileSync(fixturePath("generated-animation.json"), "utf8"));
const tilemap = JSON.parse(fs.readFileSync(fixturePath("generated-tilemap.json"), "utf8"));
const tileset = JSON.parse(fs.readFileSync(fixturePath("generated-map-tileset.json"), "utf8"));
const frames = Object.entries(atlas.frames);
const expectedFrames = ["idle_0", "run_0", "run_1", "run_2"];

assert.deepEqual(frames.map(([name]) => name).sort(), expectedFrames.slice().sort());
for (const [, value] of frames) {
  const frame = value.frame;
  assert.ok(frame.x >= 0 && frame.y >= 0 && frame.w > 0 && frame.h > 0);
  assert.ok(frame.x + frame.w <= atlas.meta.size.w && frame.y + frame.h <= atlas.meta.size.h);
  assert.deepEqual(value.pivot, { x: 0.5, y: 1 });
}
for (let leftIndex = 0; leftIndex < frames.length; leftIndex += 1) {
  const left = frames[leftIndex][1].frame;
  for (let rightIndex = leftIndex + 1; rightIndex < frames.length; rightIndex += 1) {
    const right = frames[rightIndex][1].frame;
    assert.equal(left.x < right.x + right.w && left.x + left.w > right.x && left.y < right.y + right.h && left.y + left.h > right.y, false);
  }
}
assert.deepEqual(animation.animations.map(({ key }) => key), ["acceptance-idle", "acceptance-run", "acceptance-yoyo"]);
assert.deepEqual(animation.animations[1], {
  key: "acceptance-run", frameNames: ["run_0", "run_1", "run_2"], frameRate: 6, repeat: -1,
  yoyo: false, delayMs: 0, repeatDelayMs: 0,
});
assert.equal(tilemap.width, 16);
assert.equal(tilemap.height, 6);
assert.deepEqual(tilemap.layers.map(({ name }) => name), ["background", "hidden", "ground", "props"]);
assert.deepEqual(tileset.tiles.map(({ tileName }) => tileName), ["water", "ground", "wall", "decoration"]);
process.stdout.write("issue_37_fixture_contract_passed\n");
