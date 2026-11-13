import { describe, expect, it } from "vite-plus/test";
import { type RawImage, withoutStraws } from "../icons.ts";

const SIZE = 400;

// A solid disc, the bale's body, with one opaque straw 4 pixels wide that runs from its edge to
// the image's right edge.
function baleWithStraw(): RawImage {
  const data = Buffer.alloc(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const inDisc = (x - 200) ** 2 + (y - 200) ** 2 <= 120 ** 2;
      const inStraw = x >= 320 && y >= 198 && y < 202;
      if (inDisc || inStraw) data.set([230, 180, 80, 255], (y * SIZE + x) * 4);
    }
  }
  return { data, width: SIZE, height: SIZE };
}

const alphaAt = ({ data, width }: RawImage, x: number, y: number) => data[(y * width + x) * 4 + 3];

describe("withoutStraws", () => {
  it("keeps the bale's body and removes a thin straw", async () => {
    const result = await withoutStraws(baleWithStraw());

    expect(alphaAt(result, 200, 200), "the middle of the body").toBe(255);
    expect(alphaAt(result, 380, 200), "the straw's far end").toBe(0);
  });
});
