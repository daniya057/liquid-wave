'use client';

import { motion } from 'framer-motion';
import { Play, Pause, Loader2, Sparkles } from 'lucide-react';

interface MyWaveOrbProps {
  isPlaying: boolean;
  isLoading: boolean;
  isWaveActive: boolean;
  onClick: () => void;
}

export function MyWaveOrb({ isPlaying, isLoading, isWaveActive, onClick }: MyWaveOrbProps) {
  return (
    <div className="relative flex flex-col items-center justify-center py-6 select-none">
      {/* Фоновое мягкое свечение вокруг сферы */}
      <motion.div
        animate={{
          scale: isPlaying ? [1, 1.18, 1] : [1, 1.06, 1],
          opacity: isPlaying ? [0.45, 0.75, 0.45] : [0.25, 0.35, 0.25],
        }}
        transition={{
          duration: isPlaying ? 2.4 : 4.5,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
        className="absolute w-64 h-64 rounded-full bg-gradient-to-tr from-violet-600/40 via-indigo-500/30 to-teal-400/40 blur-3xl pointer-events-none"
      />

      {/* Сама 3D-сфера */}
      <motion.button
        onClick={onClick}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.95 }}
        animate={{
          scale: isPlaying ? [1, 1.05, 0.98, 1.03, 1] : 1,
          rotate: isPlaying ? [0, 360] : 0,
        }}
        transition={{
          scale: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
          rotate: { duration: 18, repeat: Infinity, ease: 'linear' },
        }}
        className="relative w-48 h-48 sm:w-56 sm:h-56 rounded-full cursor-pointer focus:outline-none group shadow-[0_0_60px_-10px_rgba(139,92,246,0.5)]"
        style={{
          background:
            'radial-gradient(circle at 30% 25%, rgba(255,255,255,0.35) 0%, rgba(45,212,191,0.5) 25%, rgba(99,102,241,0.85) 60%, rgba(15,10,40,0.98) 100%)',
        }}
      >
        {/* Внутренний жидкий блик */}
        <div
          className="absolute inset-2 rounded-full opacity-70 blur-md mix-blend-screen"
          style={{
            background:
              'conic-gradient(from 90deg at 50% 50%, #2dd4bf, #818cf8, #c084fc, #2dd4bf)',
          }}
        />

        {/* Стеклянный ободок */}
        <div className="absolute inset-0 rounded-full border border-white/25 shadow-inner" />

        {/* Центральная кнопка и подпись */}
        <motion.div
          animate={{ rotate: isPlaying ? [0, -360] : 0 }}
          transition={{ duration: 18, repeat: Infinity, ease: 'linear' }}
          className="relative z-10 flex flex-col items-center justify-center w-full h-full text-white"
        >
          <div className="flex items-center justify-center w-14 h-14 rounded-full bg-black/30 backdrop-blur-md border border-white/20 mb-2 group-hover:bg-black/45 transition">
            {isLoading ? (
              <Loader2 className="w-6 h-6 animate-spin text-teal-300" />
            ) : isPlaying && isWaveActive ? (
              <Pause className="w-6 h-6 fill-white" />
            ) : (
              <Play className="w-6 h-6 fill-white ml-0.5" />
            )}
          </div>
          <span className="text-sm font-semibold tracking-wide drop-shadow">
            Моя волна
          </span>
          <span className="text-[11px] text-white/75 flex items-center gap-1 mt-0.5">
            <Sparkles className="w-3 h-3 text-teal-300" />
            {isPlaying && isWaveActive ? 'В потоке' : 'Нажми, чтобы запустить'}
          </span>
        </motion.div>
      </motion.button>
    </div>
  );
}