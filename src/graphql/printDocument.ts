// From @apollo/utils.printwithreducedwhitespace
// https://github.com/apollographql/apollo-utils/blob/%40apollo/utils.printwithreducedwhitespace%403.0.0/packages/printWithReducedWhitespace/src/index.ts

import {
  Kind,
  print,
  visit,
  type DocumentNode,
  type StringValueNode,
} from "@0no-co/graphql.web";

const decodeText = TextDecoder.prototype.decode.bind(new TextDecoder());
const encodeText = TextEncoder.prototype.encode.bind(new TextEncoder());

const toHex = (str: string): string => {
  const bytes = encodeText(str);
  let hex = "";

  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }

  return hex;
};

const toUTF8 = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }

  return decodeText(bytes);
};

const printDocumentCache = new Map<DocumentNode, string>();

export const printDocument = (document: DocumentNode): string => {
  const cachedDocument = printDocumentCache.get(document);

  if (cachedDocument != null) {
    return cachedDocument;
  }

  const sanitizedDocument = visit(document, {
    [Kind.STRING]: (node): StringValueNode => ({
      ...node,
      value: toHex(node.value),
      block: false,
    }),
  });

  const printedDocument = print(sanitizedDocument)
    .replace(/\s+/g, " ")
    .replace(/([^_a-zA-Z0-9]) /g, (_, c) => c)
    .replace(/ ([^_a-zA-Z0-9])/g, (_, c) => c)
    .replace(/"([a-f0-9]+)"/g, (_, hex) => JSON.stringify(toUTF8(hex)));

  printDocumentCache.set(document, printedDocument);
  return printedDocument;
};
