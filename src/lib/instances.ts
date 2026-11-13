export interface Track {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  duration: number;
}

export interface Album {
  id: string;
  title: string;
  artist: string;
  thumbnail: string;
  trackCount?: number;
}

export interface Artist {
  id: string;
  name: string;
  thumbnail: string;
  subscribers?: string;
}

export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
  createdAt: number;
}

export const WAVE_SEEDS = [
  'synthwave night drive',
  'electronic chill vocal',
  'indie pop hits',
  'deep house mix',
  'phonk drift bass',
  'ambient electronic',
];