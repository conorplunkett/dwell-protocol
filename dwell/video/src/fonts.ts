import {loadFont} from '@remotion/fonts';
import {staticFile} from 'remotion';

// Latin-subset woff2 files vendored in public/fonts (SIL OFL) so renders
// never depend on network access.
const faces = [
  {family: 'Sora', weight: '400', file: 'Sora-400.woff2'},
  {family: 'Sora', weight: '600', file: 'Sora-600.woff2'},
  {family: 'Sora', weight: '700', file: 'Sora-700.woff2'},
  {family: 'Sora', weight: '800', file: 'Sora-800.woff2'},
  {family: 'JetBrains Mono', weight: '400', file: 'JetBrainsMono-400.woff2'},
  {family: 'JetBrains Mono', weight: '600', file: 'JetBrainsMono-600.woff2'},
];

export const fontsReady = Promise.all(
  faces.map((f) =>
    loadFont({
      family: f.family,
      weight: f.weight,
      url: staticFile(`fonts/${f.file}`),
    }),
  ),
);
