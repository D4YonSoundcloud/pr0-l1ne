/**
 * `import url from "./file.wasm?url"`: Vite gives the file's address (in a
 * build, its hashed copy). vite/client declares this for the app's own
 * code; this is for code that tests also type-check under Node's types
 * (tsconfig.node.json).
 */
declare module "*.wasm?url" {
  const url: string;
  export default url;
}
