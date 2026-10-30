// unbzip2-stream (MIT) ships no types: a Transform from bzip2 to raw bytes.
declare module "unbzip2-stream" {
  const unbzip2: () => NodeJS.ReadWriteStream;
  export default unbzip2;
}
