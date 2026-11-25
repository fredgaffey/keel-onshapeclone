// The files Keel can turn into a document. Converting happens in the browser, by SolidCraft
// (its `document.import_file`, patches/solidcraft/0004): the server never reads the geometry.
//
// kind: design   a SolidCraft design, opened as it is
//       cad      exact solids (B-rep): STEP, IGES
//       mesh     triangles: STL, 3MF, OBJ, glTF
//       points   point clouds
//       drawing  2D geometry, as a sketch
//       board    a KiCad circuit board
//       closed   a format only its own maker's software reads (Fusion 360, SolidWorks, ...)

export const FORMATS = [
  { ext: ['sc', 'solidcraft', 'json'], label: 'SolidCraft / Keel design', kind: 'design' },
  { ext: ['step', 'stp'], label: 'STEP', kind: 'cad' },
  { ext: ['iges', 'igs'], label: 'IGES', kind: 'cad' },
  { ext: ['stl'], label: 'STL', kind: 'mesh', units: true },
  { ext: ['obj'], label: 'OBJ', kind: 'mesh', units: true },
  { ext: ['3mf'], label: '3MF', kind: 'mesh' },
  { ext: ['glb', 'gltf'], label: 'glTF', kind: 'mesh' },
  { ext: ['ply', 'xyz', 'pts'], label: 'Point cloud (PLY, XYZ, PTS)', kind: 'points' },
  { ext: ['dxf'], label: 'DXF drawing', kind: 'drawing' },
  { ext: ['kicad_pcb'], label: 'KiCad board', kind: 'board' },
  { ext: ['f3d', 'f3z'], label: 'Fusion 360', kind: 'closed', from: 'Fusion 360', how: 'In Fusion 360: File → Export, choose STEP (.step), and import that file. From the Fusion web app or a hub, use Download → STEP.' },
  { ext: ['sldprt', 'sldasm'], label: 'SolidWorks', kind: 'closed', from: 'SolidWorks', how: 'In SolidWorks: File → Save As, choose STEP AP214 (*.step), and import that file. eDrawings can also export STEP.' },
  { ext: ['ipt', 'iam'], label: 'Inventor', kind: 'closed', from: 'Inventor', how: 'In Inventor: File → Export → CAD Format, choose STEP, and import that file.' },
  { ext: ['catpart', 'catproduct'], label: 'CATIA', kind: 'closed', from: 'CATIA', how: 'In CATIA: File → Save As, choose stp, and import that file.' },
  { ext: ['prt', 'asm'], label: 'Creo / NX', kind: 'closed', from: 'Creo or NX', how: 'In Creo or NX: File → Save a Copy / Export, choose STEP, and import that file.' },
  { ext: ['x_t', 'x_b'], label: 'Parasolid', kind: 'closed', from: 'Parasolid', how: 'Export STEP from the program that made it, and import that file.' },
  { ext: ['skp'], label: 'SketchUp', kind: 'closed', from: 'SketchUp', how: 'In SketchUp: File → Export → 3D Model, choose OBJ or STL, and import that file.' },
  { ext: ['fcstd', '3dm'], label: 'FreeCAD / Rhino', kind: 'closed', from: 'FreeCAD or Rhino', how: 'SolidCraft\'s desktop app reads these directly. In the browser, export STEP from FreeCAD or Rhino and import that.' },
];

export const UNIT_CHOICES = [['mm', 'millimetres'], ['cm', 'centimetres'], ['m', 'metres'], ['in', 'inches'], ['ft', 'feet']];

export function formatOf(fileName) {
  const lower = String(fileName).toLowerCase();
  const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.') + 1) : '';
  return FORMATS.find((f) => f.ext.includes(ext)) || null;
}

/** For an <input type=file accept=…>: every format Keel can turn into a document. */
export const ACCEPT = FORMATS.flatMap((f) => f.ext.map((e) => `.${e}`)).join(',');

/** "STEP, IGES, STL, …" for messages. */
export const READABLE = FORMATS.filter((f) => f.kind !== 'closed' && f.kind !== 'design').map((f) => f.label).join(', ');

/** The document name a file gives: its name without the extension. */
export function nameFromFile(fileName) {
  return String(fileName).replace(/\.[A-Za-z0-9_]+$/, '').replace(/ \([A-Za-z0-9-]+\)$/, '').trim().slice(0, 120) || 'Imported design';
}
