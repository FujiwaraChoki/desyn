import Link from "next/link";

export default function NotFound() {
  return (
    <div className="doc-layout">
      <article className="doc not-found">
        <header className="doc-header">
          <p className="eyebrow">404</p>
          <h1>
            this page is <em>not here</em>.
          </h1>
          <p className="lead">
            The link may be old, or the page moved. Search the docs or start from the introduction.
          </p>
        </header>
        <p className="not-found-actions">
          <Link href="/" className="button-primary">
            Go to the introduction
          </Link>
        </p>
      </article>
    </div>
  );
}
