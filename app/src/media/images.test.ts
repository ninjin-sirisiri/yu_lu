import { MAX_IMAGE_BYTES, MAX_IMAGES, validImageCount, validImageSize } from './images';

describe('validImageCount', () => {
  it('accepts 0 through MAX_IMAGES', () => {
    for (let count = 0; count <= MAX_IMAGES; count += 1) {
      expect(validImageCount(count)).toBe(true);
    }
  });

  it('rejects more than 4 images', () => {
    expect(validImageCount(MAX_IMAGES + 1)).toBe(false);
  });

  it('rejects negative counts', () => {
    expect(validImageCount(-1)).toBe(false);
  });
});

describe('validImageSize', () => {
  it('accepts sizes up to 10 MB', () => {
    expect(validImageSize(1)).toBe(true);
    expect(validImageSize(MAX_IMAGE_BYTES)).toBe(true);
  });

  it('rejects sizes over 10 MB', () => {
    expect(validImageSize(MAX_IMAGE_BYTES + 1)).toBe(false);
  });

  it('rejects empty and negative sizes', () => {
    expect(validImageSize(0)).toBe(false);
    expect(validImageSize(-1)).toBe(false);
  });
});
