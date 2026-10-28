import { strToU8, zipSync } from "fflate";

/** Tiny PNG signature (enough for archive / media tests). */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

// A minimal but complete PowerPoint package: layout / master / theme inheritance, notes, picture, group. ---------------------------------------------------------------------------------------

const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"';
const T = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const EMU = 9525;

function rels(list: [string, string, string][]): Uint8Array {
  return strToU8(
    `<?xml version="1.0"?><Relationships ${REL}>${list
      .map(
        ([id, type, target]) => `<Relationship Id="${id}" Type="${T}/${type}" Target="${target}"/>`,
      )
      .join("")}</Relationships>`,
  );
}

const xfrm = (x: number, y: number, w: number, h: number, extra = "") =>
  `<a:xfrm${extra}><a:off x="${x * EMU}" y="${y * EMU}"/><a:ext cx="${w * EMU}" cy="${h * EMU}"/></a:xfrm>`;

export function samplePptx(media: Uint8Array = PNG): Uint8Array {
  const slide = `<?xml version="1.0"?><p:sld ${A} ${P} ${R}><p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>
        <p:txBody><a:bodyPr anchor="ctr"/><a:p><a:pPr algn="ctr"/><a:r><a:rPr sz="4000" b="1"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:latin typeface="Inter"/></a:rPr><a:t>Hello deck</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>
      <p:sp><p:nvSpPr><p:cNvPr id="3" name="Card"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>
        <p:spPr>${xfrm(100, 400, 300, 120, ' rot="5400000"')}<a:prstGeom prst="roundRect"/><a:solidFill><a:srgbClr val="FFB02E"><a:alpha val="50000"/></a:srgbClr></a:solidFill><a:ln w="${2 * EMU}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:ln></p:spPr></p:sp>
      <p:cxnSp><p:nvCxnSpPr><p:cNvPr id="4" name="Line"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>
        <p:spPr>${xfrm(0, 0, 300, 400, ' flipV="1"')}<a:ln w="${3 * EMU}"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></p:spPr></p:cxnSp>
      <p:pic><p:nvPicPr><p:cNvPr id="5" name="Photo" descr="A sunset"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
        <p:blipFill><a:blip r:embed="rId2"/><a:srcRect l="10000" r="10000"/></p:blipFill><p:spPr>${xfrm(500, 100, 400, 300)}</p:spPr></p:pic>
      <p:grpSp><p:nvGrpSpPr><p:cNvPr id="6" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
        <p:grpSpPr><a:xfrm><a:off x="${600 * EMU}" y="${500 * EMU}"/><a:ext cx="${200 * EMU}" cy="${100 * EMU}"/><a:chOff x="0" y="0"/><a:chExt cx="${400 * EMU}" cy="${200 * EMU}"/></a:xfrm></p:grpSpPr>
        <p:sp><p:nvSpPr><p:cNvPr id="7" name="Dot"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(200, 100, 100, 100)}<a:prstGeom prst="ellipse"/><a:solidFill><a:srgbClr val="00FF00"/></a:solidFill></p:spPr></p:sp>
      </p:grpSp>
    </p:spTree></p:cSld></p:sld>`;
  const layout = `<?xml version="1.0"?><p:sldLayout ${A} ${P}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(80, 40, 1120, 160)}</p:spPr></p:sp>
  </p:spTree></p:cSld></p:sldLayout>`;
  const master = `<?xml version="1.0"?><p:sldMaster ${A} ${P}><p:cSld><p:spTree/></p:cSld></p:sldMaster>`;
  const theme = `<?xml version="1.0"?><a:theme ${A}><a:themeElements><a:clrScheme name="x">
    <a:dk1><a:sysClr val="windowText" lastClr="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
    <a:accent1><a:srgbClr val="0A0A0A"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`;
  const notes = `<?xml version="1.0"?><p:notes ${A} ${P}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Say hello</a:t></a:r></a:p><a:p><a:r><a:t>Then smile</a:t></a:r></a:p></p:txBody></p:sp>
  </p:spTree></p:cSld></p:notes>`;
  const pres = `<?xml version="1.0"?><p:presentation ${A} ${P} ${R}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="${1280 * EMU}" cy="${720 * EMU}"/></p:presentation>`;
  return zipSync({
    "ppt/presentation.xml": strToU8(pres),
    "ppt/_rels/presentation.xml.rels": rels([["rId1", "slide", "slides/slide1.xml"]]),
    "ppt/slides/slide1.xml": strToU8(slide),
    "ppt/slides/_rels/slide1.xml.rels": rels([
      ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
      ["rId2", "image", "../media/image1.png"],
      ["rId3", "notesSlide", "../notesSlides/notesSlide1.xml"],
    ]),
    "ppt/slideLayouts/slideLayout1.xml": strToU8(layout),
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": rels([
      ["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"],
    ]),
    "ppt/slideMasters/slideMaster1.xml": strToU8(master),
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": rels([
      ["rId1", "theme", "../theme/theme1.xml"],
    ]),
    "ppt/theme/theme1.xml": strToU8(theme),
    "ppt/notesSlides/notesSlide1.xml": strToU8(notes),
    "ppt/media/image1.png": media,
  });
}
