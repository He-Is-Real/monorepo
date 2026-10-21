import Image from 'next/image';
import logo from '../assets/logo-white.webp';

// Placeholder until the walking-skeleton story page (M0 task 0.9).
export default function Page() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-site flex-col items-center justify-center gap-6 px-5 py-16 text-center sm:px-10"
    >
      <Image
        src={logo}
        alt="He Is Real: Encounters with God"
        width={160}
        height={160}
        priority
      />
      <h1 className="text-4xl font-normal leading-tight sm:text-5xl">
        He Is Real Today
      </h1>
      <p className="max-w-narrow text-lg text-secondary-text">
        Real stories of encounters with God.
      </p>
    </main>
  );
}
