import type { MDXComponents } from "mdx/types";
import { ArchitectureDiagram } from "./architecture-diagram";
import { Callout } from "./callout";
import { CodeBlock } from "./code-block";
import {
  Badge,
  Card,
  Cards,
  Endpoint,
  EnvList,
  EnvVar,
  Method,
  Param,
  Params,
  Steps,
  TableWrap,
} from "./content-blocks";
import { H2, H3, H4 } from "./heading";
import { Kbd, Keys } from "./keys";
import { SmartLink } from "./smart-link";
import { Tab, Tabs } from "./tabs";

/** Element overrides and the components MDX pages may use. */
export const mdxComponents: MDXComponents = {
  a: SmartLink,
  pre: CodeBlock,
  table: TableWrap,
  h2: H2,
  h3: H3,
  h4: H4,
  ArchitectureDiagram,
  Badge,
  Callout,
  Card,
  Cards,
  Endpoint,
  EnvList,
  EnvVar,
  Kbd,
  Keys,
  Method,
  Param,
  Params,
  Steps,
  Tab,
  Tabs,
};
