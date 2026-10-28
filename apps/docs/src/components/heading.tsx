import type { HTMLAttributes, ReactNode } from "react";

type HeadingProps = HTMLAttributes<HTMLHeadingElement> & { children?: ReactNode };

function makeHeading(Tag: "h2" | "h3" | "h4") {
  function Heading({ id, children, ...rest }: HeadingProps) {
    return (
      <Tag id={id} {...rest}>
        {children}
        {id ? (
          <a className="heading-anchor" href={`#${id}`} aria-label="Link to this section">
            #
          </a>
        ) : null}
      </Tag>
    );
  }
  Heading.displayName = Tag;
  return Heading;
}

export const H2 = makeHeading("h2");
export const H3 = makeHeading("h3");
export const H4 = makeHeading("h4");
