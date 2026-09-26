'use client';

import React, { useState, useEffect } from 'react';

export default function Home() {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      
        CRYPTORIUM // INITIALIZING CORE...
      
    );
  }

  return (
