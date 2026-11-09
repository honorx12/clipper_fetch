import Link from 'next/link';

export default function Nav({ current }: { current: 'library' | 'studio' }) {
  return (
    <nav className="nav" aria-label="Main">
      <span className="brand">ClipFetch</span>
      <div className="navlinks">
        <Link href="/" aria-current={current === 'library' ? 'page' : undefined}>
          Library
        </Link>
        <Link href="/studio" aria-current={current === 'studio' ? 'page' : undefined}>
          Create clip
        </Link>
      </div>
    </nav>
  );
}
