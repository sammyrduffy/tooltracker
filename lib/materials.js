// ---------------------------------------------------------------------------
// materials.js  —  The fixed list of material types used for filtering.
//
// To add or rename a type, edit this list. Existing materials keep whatever
// type string they were saved with, so renaming here won't change old records.
// ---------------------------------------------------------------------------

const MATERIAL_TYPES = [
  'Structural',
  'Framing',
  'Exterior',
  'Interior',
  'Plumbing',
  'Electrical',
  'HVAC',
  'Finishes',
  'Hardware & Fasteners',
  'Sitework & Landscaping',
  'Safety',
  'Miscellaneous',
];

// Normalizes a material name so small differences in case, spacing, and simple
// plurals all collapse to the SAME key. Used to decide whether two materials
// are "the same" for merging quantities. Examples that all match:
//   "2x4x8 stud", "2 x 4 x 8 Stud", "2 x 4 x8 STUDS"  ->  "2x4x8stud"
function materialKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/×/g, 'x')    // treat the "×" symbol the same as the letter "x"
    .replace(/\s+/g, '')   // ignore all spaces ("2 x 4" == "2x4")
    .replace(/s$/, '');    // ignore a trailing "s" ("studs" == "stud")
}

module.exports = { MATERIAL_TYPES, materialKey };
