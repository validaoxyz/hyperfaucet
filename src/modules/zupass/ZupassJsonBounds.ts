export interface BoundedJsonDocumentOptions {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly errorMessages: {
    readonly size: string;
    readonly nesting: string;
  };
}

export function assertBoundedJsonDocument(
  value: string,
  options: BoundedJsonDocumentOptions,
): void {
  if(value.length > options.maxBytes || Buffer.byteLength(value, "utf8") > options.maxBytes)
    throw new Error(options.errorMessages.size);

  let depth = 0;
  let inString = false;
  let escaped = false;
  for(const character of value) {
    if(inString) {
      if(escaped)
        escaped = false;
      else if(character === "\\")
        escaped = true;
      else if(character === '"')
        inString = false;
      continue;
    }
    if(character === '"') {
      inString = true;
      continue;
    }
    if(character === "{" || character === "[") {
      depth++;
      if(depth > options.maxDepth)
        throw new Error(options.errorMessages.nesting);
    } else if(character === "}" || character === "]") {
      depth--;
    }
  }
}
