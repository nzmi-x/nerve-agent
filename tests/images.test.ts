import { test, expect } from "bun:test";
import { imageMime, imageRefs, imagePlaceholder } from "../src/images.ts";

test("imageMime: Gemini-supported extensions map; others → null", () => {
  expect(imageMime("a.png")).toBe("image/png");
  expect(imageMime("a.JPG")).toBe("image/jpeg"); // case-insensitive
  expect(imageMime("a.jpeg")).toBe("image/jpeg");
  expect(imageMime("a.webp")).toBe("image/webp");
  expect(imageMime("a.heic")).toBe("image/heic");
  expect(imageMime("a.gif")).toBeNull(); // Gemini doesn't take GIF
  expect(imageMime("a.txt")).toBeNull();
  expect(imageMime("noext")).toBeNull();
});

test("imageRefs: finds @<image> tokens, leaves text/email refs alone", () => {
  expect(imageRefs("look at @screenshot.png please")).toEqual([{ token: "@screenshot.png", path: "screenshot.png" }]);
  expect(imageRefs("@a/b/c.jpg and @x.webp")).toEqual([
    { token: "@a/b/c.jpg", path: "a/b/c.jpg" },
    { token: "@x.webp", path: "x.webp" },
  ]);
  expect(imageRefs("@notes.txt is a doc")).toEqual([]); // not an image extension → ignored (read-tool ref)
  expect(imageRefs("no refs here")).toEqual([]);
});

test("imageRefs: trailing punctuation isn't swallowed into the path", () => {
  expect(imageRefs("see @img.png.")).toEqual([{ token: "@img.png", path: "img.png" }]);
  expect(imageRefs("(@shot.jpeg)")).toEqual([{ token: "@shot.jpeg", path: "shot.jpeg" }]);
});

test("imagePlaceholder: basename only", () => {
  expect(imagePlaceholder("/home/naz/Pictures/screenshot.png")).toBe("[image: screenshot.png]");
  expect(imagePlaceholder("a.webp")).toBe("[image: a.webp]");
});
