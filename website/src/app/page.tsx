import { Features } from '@/components/sections/Features';
import { Hero } from '@/components/sections/Hero';

// Landing narrative: hero (pitch + install command) → feature cards.
// Site chrome (header, footer) lives in the root layout.
export default function HomePage() {
  return (
    <main className="flex-1">
      <Hero />
      <Features />
    </main>
  );
}
