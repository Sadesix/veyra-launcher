const { randomInt } = require('node:crypto');
const backgrounds = [
  { id: 'default', name: 'Первая история', url: '../assets/veyra-hero.jpg', thumbnail: '../assets/backgrounds/default-thumb.webp' },
  ...['Глубины', 'Аметист', 'Сакура', 'Северное сияние', 'Цветущая долина', 'После заката', 'Золотой час', 'Кровавая луна'].map((name, i) => ({
    id: 'scene-' + (i + 1), name, url: '../assets/backgrounds/scene-' + (i + 1) + '.webp', thumbnail: '../assets/backgrounds/scene-' + (i + 1) + '-thumb.webp',
  })),
];
const validBackground = id => backgrounds.some(item => item.id === id);
const randomBackground = () => backgrounds[1 + randomInt(backgrounds.length - 1)].id;
module.exports = { backgrounds, validBackground, randomBackground };
