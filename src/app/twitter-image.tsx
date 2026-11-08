import { renderSocialCard } from './opengraph-image';

/** Same card as the Open Graph image, so X/Twitter shows it too. */
export const alt = 'Firstlight: earthquake relief cash in minutes, no application needed';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function TwitterImage() {
  return renderSocialCard();
}
