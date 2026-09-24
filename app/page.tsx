'use client';

export default function Home() {
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
