// @ts-nocheck
import { Track } from '@/lib/instances';

export type MoodType = 'all' | 'calm' | 'energetic' | 'sad';

export const MOOD_OPTIONS: { id: MoodType; label: string }[] = [
  { id: 'all', label: 'Все' },
  { id: 'calm', label: 'Спокойные' },
  { id: 'energetic', label: 'Энергичные' },
  { id: 'sad', label: 'Грустные' },
];

const CALM_KEYWORDS = [
  'acoustic', 'piano', 'ambient', 'lofi', 'lo-fi', 'chill', 'sleep', 'slowed',
  'instrumental', 'soft', 'calm', 'ballad', 'rain', 'night', 'dream', 'jazz',
  'soul', 'meditation', 'study', 'relax', 'unplugged', 'cover', 'lullaby',
  'акустик', 'пиано', 'спокойн', 'ночь', 'сон', 'чилл', 'медляк', 'колыбельн',
];

const CALM_ARTISTS = [
  'lana del rey', 'cigarettes after sex', 'joji', 'billie eilish', 'frank ocean',
  'mac demarco', 'the neighbourhood', 'ludovico einaudi', 'c418', 'bon iver',
  'daniel caesar', 'kali uchis', 'clairo', 'men i trust', 'beach house',
  'miyagi', 'скриптонит', 'saluki', 'sirotkin', 'сироткин', 'монеточка',
];

const ENERGETIC_KEYWORDS = [
  'phonk', 'remix', 'hardstyle', 'club', 'dance', 'bass', 'rock', 'metal',
  'workout', 'gym', 'drift', 'sped up', 'speed up', 'trap', 'banger', 'party',
  'hype', 'drill', 'edm', 'techno', 'house', 'dubstep', 'punk', 'boosted',
  'фонк', 'ремикс', 'басс', 'рок', 'клуб', 'танц', 'драйв', 'кач',
];

const SAD_KEYWORDS = [
  'sad', 'heartbreak', 'tears', 'cry', 'pain', 'alone', 'lonely', 'broken',
  'miss you', 'goodbye', 'death', 'hurt', 'empty', 'dark', 'depress',
  'груст', 'боль', 'слез', 'одиноч', 'тоск', 'прощай', 'разбит', 'лирик',
];

export function detectTrackMood(track: Track): Exclude<MoodType, 'all'> {
  const title = (track.title || '').toLowerCase();
  const artist = (track.artist || '').toLowerCase();
  const text = `${artist} ${title}`;

  if (ENERGETIC_KEYWORDS.some((kw) => text.includes(kw))) {
    return 'energetic';
  }

  if (SAD_KEYWORDS.some((kw) => text.includes(kw))) {
    return 'sad';
  }

  if (
    CALM_KEYWORDS.some((kw) => text.includes(kw)) ||
    CALM_ARTISTS.some((a) => artist.includes(a))
  ) {
    return 'calm';
  }

  if (track.duration && track.duration > 270) {
    return 'calm';
  }

  return 'energetic';
}

export function filterTracksByMood(tracks: Track[], mood: MoodType): Track[] {
  if (mood === 'all') return tracks;
  return tracks.filter((t) => detectTrackMood(t) === mood);
}