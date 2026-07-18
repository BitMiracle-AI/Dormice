import { Features } from '@/components/sections/Features';
import { GetStarted } from '@/components/sections/GetStarted';
import { Hero } from '@/components/sections/Hero';
import { Lifecycle } from '@/components/sections/Lifecycle';

// Landing narrative: hero (pitch + E2B migration panel + install command)
// → lifecycle ladder (the differentiator) → feature grid → closing CTA.
// Site chrome (header, footer) lives in the root layout.
export default function HomePage() {
  return (
    <main className="flex-1">
      <Hero />
      <Lifecycle />
      <Features />
      <GetStarted />
    </main>
  );
}
