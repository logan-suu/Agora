import type { PublicName } from './accounting';
import { PUBLIC_REVISION } from './public-adapter';

// Curated only from the pinned public starter, instructions and assertions, never proof code.
export const PUBLIC_CONTRACTS = {
  'grade-school': {
    sources: {
      'grade-school.js': '1eb3ebac5d31f2ab784068fc7d3ec8b93ccacfcc5507cb6882efac7a8999dce2',
      '.docs/instructions.md': '8dc7133cd5f0564717108757c27ad96ebadf44f03b5fde5c35b826aaeb0b4e0f',
      'grade-school.spec.js': '055838a67683c40987054b9df345f4fb8dce41cd4e0fbf54f45b73d6a8e2d024',
    },
    facts: [
      'Export the GradeSchool class with add(name, grade), grade(grade), and roster(). A new roster is {}; an unoccupied grade returns [].',
      'roster() maps grade numbers to arrays of student names. Names within each grade are alphabetically sorted, and grades appear in ascending numeric order.',
      "grade(grade) returns that grade's student names in alphabetical order, even when inserted out of order. Sorting is required for both grade() and roster(); grade() ordering must not be classified as unspecified or a non-goal.",
      "Mutating an array obtained from roster() or grade() must not change the school's stored roster.",
      "Cross-grade duplicate case: add('Aimee', 2), then add('Aimee', 1); grade(2) must return []. Neither call throws. The public case checks departure from grade 2; it does not separately assert grade(1) after those calls.",
      'add() return values are not asserted. Do not require true/false, an exception, or an unchanged roster on duplicate addition based on the ambiguous prose. Preserve the explicit cross-grade case above.',
    ],
  },
  wordy: {
    sources: {
      'wordy.js': 'a3e38272e31830d28d4b7e796287b7e838e0963f4dcdd219585d6b08d10212a6',
      '.docs/instructions.md': 'b9e24dd95b27fa04f706e4dd9e5c7f430684b1af13a1cfde34faee705300aeee',
      'wordy.spec.js': 'a84461b9dbe0e07c41bf655a3266bc9b1e0aced504da0df3034d9a4ca4d04dac',
    },
    facts: [
      "Export answer(question), returning the numeric result of an English arithmetic question such as 'What is 5?'. Signed integers and the operators plus, minus, multiplied by, and divided by are covered.",
      "Evaluate successive operations from left to right, without ordinary multiplication precedence: 'What is -3 plus 7 multiplied by -2?' returns -8.",
      "An unknown operation such as 'What is 52 cubed?' and a non-math question throw Error('Unknown operation').",
      "Malformed supported arithmetic throws Error('Syntax error'): 'What is?', 'What is 1 plus?', two adjacent operators, adjacent numbers, prefix notation, and postfix notation. Do not use one generic error for both categories.",
    ],
  },
  'book-store': {
    sources: {
      'book-store.js': 'dddec1d9d2a60c4c7e32f4f7b9f9245078907d46e3d24a7dbc1011e2738d882f',
      '.docs/instructions.md': '025999b58db674568be4d2239fc577b749ec40e98593fc3638e21e72915ad4c5',
      '.docs/instructions.append.md':
        '2e5a5a532d6785aaa47e537b555f55c07555efbdab4c0317a4ad6fbf5078d741',
      'book-store.spec.js': 'b5173e06b26eac34667c4ed456e0d3a1a70d929ee6da2d1ab661baa31f9f9320',
    },
    facts: [
      'Export cost(books), accepting an array of volume numbers 1 through 5, with repetitions allowed. Return the minimum total price in integer cents. An empty basket costs 0; one book costs 800; two identical books cost 1600.',
      'A discounted group contains distinct volumes. Group totals for sizes 2, 3, 4, and 5 are respectively 1520, 2160, 2560, and 3000 cents. Equal volumes cannot receive a distinct-volume discount within the same group.',
      'Choose the least expensive partition of the entire basket. For [1,1,2,2,3,3,4,5], the public expected cost is 5120. The order of books in the basket does not change the price. No algorithm or implementation is prescribed.',
    ],
  },
  forth: {
    sources: {
      'forth.js': '10b22e0a92b020bef406ad5f13fb75b28350373269a0cec097a61e7ec2eb6cc4',
      '.docs/instructions.md': '06875da79159e3783cde3d006e405f8329e16837b09b0b4b8225efc3d27a6d9c',
      'forth.spec.js': 'd54c1cf8c7e20d26bd173e451c0a04d9617ec2a9a7c14d16762942fd17e7ee6d',
    },
    facts: [
      'Export the Forth class. evaluate(program) executes a space-separated program; stack is an array ordered from bottom to top. State and user definitions persist across evaluate calls on one instance, but definitions are local to each instance.',
      'Signed integer literals push onto the stack. Support +, -, *, / and dup, drop, swap, over. Subtraction and division use the second-from-top operand first; 3 4 - yields -1 and 8 3 / yields integer 2.',
      'dup copies the top value; drop removes it; swap exchanges the top two values; over copies the second-from-top value to the top.',
      "Insufficient operands throw Error('Stack empty'); division by zero throws Error('Division by zero'); an undefined word throws Error('Unknown command').",
      "Define a word with ': name body ;'. Names and built-ins are case-insensitive. User definitions may replace existing words or operators; numeric names, including negative numbers, throw Error('Invalid definition').",
      "Word references retain the definitions in effect when defined: defining foo as 5, then bar as foo, then redefining foo as 6 makes 'bar foo' yield [5,6]. A redefinition may use its previous definition: foo initially 10, then redefined as 'foo 1 +', yields 11.",
    ],
  },
} as const;

export function assertPublicContractSources(
  name: PublicName,
  sources: readonly { path: string; sha256: string }[],
): void {
  const expected = Object.entries(PUBLIC_CONTRACTS[name].sources);
  if (
    sources.length !== expected.length ||
    new Set(sources.map((s) => s.path)).size !== expected.length ||
    expected.some(([path, hash]) => sources.find((s) => s.path === path)?.sha256 !== hash)
  )
    throw new Error('public contract source mismatch; review the clarification before use');
}
export function publicContractText(name: PublicName): string {
  return `Public contract clarification (revision ${PUBLIC_REVISION}; starter and public assertions):\n${PUBLIC_CONTRACTS[name].facts.map((fact) => `- ${fact}`).join('\n')}\nThese explicit facts override ambiguous or conflicting original prose. PM has no tools and must use these facts directly. Unspecified behavior must remain unspecified; do not invent error, return-value or edge-case policies. Roles with file tools can inspect the public contract for further detail.`;
}
