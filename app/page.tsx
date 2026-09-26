'use client';
import React, { useState, useEffect } from 'react';

export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // This triggers the app to load after the initial render
    setMounted(true);
  }, []);

  // This is your Loading Screen
  if (!mounted) {
    return (
      <div className="flex items-center justify-center w-screen h-screen bg-[#0e1013] text-white font-mono">
        <div className="text-center">
          <h1 className="text-3xl font-bold mb-2 tracking-widest">CRYPTORIUM</h1>
          <p className="text-sm text-gray-400 animate-pulse">INITIALIZING CORE...</p>
        </div>
      </div>
    );
  }

  // This is your Original App Interface
  return (
    <main className="w-screen h-screen m-0 p-0 overflow-hidden bg-[#0e1013]">
      <iframe
        src="/index.html"
        title="Cryptorium // Automated Futures Engine"
        id="cryptoriumTerminalFrame"
        className="w-full h-full border-0 block bg-[#0e1013]"
      />
    </main>
  );
}
