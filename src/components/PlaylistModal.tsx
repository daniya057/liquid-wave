'use client';

import { useState } from 'react';
import { Playlist, Track } from '@/lib/instances';
import { X, Plus, Check, ListMusic } from 'lucide-react';

interface PlaylistModalProps {
  track: Track | null;
  playlists: Playlist[];
  onClose: () => void;
  onCreatePlaylist: (name: string, initialTrack?: Track) => void;
  onToggleTrack: (playlistId: string, track: Track) => void;
}

export function PlaylistModal({
  track,
  playlists,
  onClose,
  onCreatePlaylist,
  onToggleTrack,
}: PlaylistModalProps) {
  const [newName, setNewName] = useState('');

  if (!track) return null;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) return;
    onCreatePlaylist(newName.trim(), track);
    setNewName('');
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl bg-[#121217] border border-white/15 p-6 space-y-5 shadow-2xl"
      >
        <div className="flex items-center justify-between">
          <div className="min-w-0 pr-3">
            <h3 className="text-base font-semibold text-white">Добавить в плейлист</h3>
            <p className="text-xs text-white/50 truncate mt-0.5">{track.title}</p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-full bg-white/[0.06] hover:bg-white/15 text-white/70 hover:text-white transition cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Создание нового плейлиста сразу с этим треком */}
        <form onSubmit={handleCreate} className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Название нового плейлиста..."
            className="flex-1 px-3.5 py-2.5 rounded-xl bg-white/[0.05] border border-white/10 text-xs text-white placeholder:text-white/35 focus:outline-none focus:border-teal-400/50"
          />
          <button
            type="submit"
            className="px-3.5 py-2.5 rounded-xl bg-teal-500/20 hover:bg-teal-500/30 border border-teal-400/40 text-xs font-medium text-teal-200 flex items-center gap-1 transition cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Создать</span>
          </button>
        </form>

        {/* Список существующих плейлистов */}
        <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
          {playlists.length === 0 ? (
            <p className="text-center text-xs text-white/40 py-6">
              У тебя пока нет плейлистов — создай первый выше.
            </p>
          ) : (
            playlists.map((pl) => {
              const added = pl.tracks.some((t) => t.id === track.id);
              return (
                <button
                  key={pl.id}
                  onClick={() => onToggleTrack(pl.id, track)}
                  className={`w-full flex items-center justify-between p-3 rounded-2xl border text-left transition cursor-pointer ${
                    added
                      ? 'bg-teal-500/15 border-teal-400/40 text-white'
                      : 'bg-white/[0.03] hover:bg-white/[0.07] border-white/10 text-white/85'
                  }`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
                      <ListMusic className="w-4 h-4 text-teal-300" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{pl.name}</p>
                      <p className="text-[11px] text-white/45">{pl.tracks.length} треков</p>
                    </div>
                  </div>
                  <div
                    className={`w-6 h-6 rounded-full flex items-center justify-center border ${
                      added
                        ? 'bg-teal-400 border-teal-400 text-zinc-950'
                        : 'border-white/25 text-transparent'
                    }`}
                  >
                    <Check className="w-3.5 h-3.5 stroke-[3]" />
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}