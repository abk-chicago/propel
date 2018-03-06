/*!
   Copyright 2018 Propel http://propel.site/.  All rights reserved.
   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
 */
import * as acorn from "acorn/dist/acorn";
import * as walk from "acorn/dist/walk";
import { assert } from "../src/util";

function noop() {}

function walkRecursiveWithAncestors(node, state, visitors) {
  const ancestors = [];
  const wrappedVisitors = {};

  for (const nodeType of Object.keys(walk.base)) {
    const visitor = visitors[nodeType] || walk.base[nodeType];
    wrappedVisitors[nodeType] = (node, state, c) => {
      const isNew = node !== ancestors[ancestors.length - 1];
      if (isNew) ancestors.push(node);
      visitor(node, state, c, ancestors);
      if (isNew) ancestors.pop();
    };
  }

  return walk.recursive(node, state, wrappedVisitors);
}

/* tslint:disable:object-literal-sort-keys*/

const importVisitors = {
  ImportDeclaration(node, state, c) {
    const spec = node.specifiers;
    const src = node.source;

    if (spec.length) {
      let cur = spec[0];
      state.edit.replace(node.start, cur.start, "var {");
      for (let i = 1; i < spec.length; i++) {
        state.edit.replace(cur.end, spec[i].start, ",");
        cur = spec[i];
      }
      state.edit.replace(cur.end, src.start, `} = {_:await __import(`);
      state.edit.replace(src.end, node.end, ")};");
    } else {
      state.edit.replace(node.start, src.start, `await __import(`);
      state.edit.replace(src.end, node.end, ");");
    }

    walk.base.ImportDeclaration(node, state, c);
  },

  ImportSpecifier(node, state, c) {
    state.edit.insertBefore(node, "_:{");
    if (node.local.start > node.imported.end) {
      state.edit.replace(node.imported.end, node.local.start, ":");
    }
    state.edit.insertAfter(node, "}");
    walk.base.ImportSpecifier(node, state, c);
  },

  ImportDefaultSpecifier(node, state, c) {
    state.edit.insertBefore(node.local, "_:{default:");
    state.edit.insertAfter(node.local, "}");
    walk.base.ImportDefaultSpecifier(node, state, c);
  },

  ImportNamespaceSpecifier(node, state, c) {
    state.edit.replace(node.start, node.local.start, "_:");
    walk.base.ImportNamespaceSpecifier(node, state, c);
  },

  // Do not recurse into functions etc.
  FunctionDeclaration: noop,
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

const evalScopeVisitors = {
  // Turn function and class declarations into expressions that assign to
  // the global object. Do not recurse into function bodies.
  ClassDeclaration(node, state, c, ancestors) {
    walk.base.ClassDeclaration(node, state, c);

    // Classes are block-scoped, so don't do any transforms if the class
    // definition isn't at top-level.
    assert(ancestors.length >= 2);
    if (ancestors[ancestors.length - 2] !== state.body) {
      return;
    }

    state.edit.insertBefore(node, `__global.${node.id.name}=`);
    state.edit.insertAfter(node, `);`);
  },

  FunctionDeclaration(node, state, c) {
    state.edit.insertBefore(node, `void (__global.${node.id.name}=`);
    state.edit.insertAfter(node, `);`);
    // Don't do any translation inside the function body, therefore there's no
    // `walk.base.FunctionDeclaration()` call here.
  },

  VariableDeclaration(node, state, c, ancestors) {
    // Turn variable declarations into assignments to the global object.
    // TODO: properly hoist `var` declarations -- that is, insert
    // `global.varname = undefined` at the very top of the block.

    // Translate all `var` declarations as they are function-scoped.
    // `let` and `const` are only translated when they appear in the top level
    // block. Note that since we don't walk into function bodies, declarations
    // inside them are never translated.
    assert(ancestors.length >= 2);
    const translateDecl =
      node.kind === "var" || ancestors[ancestors.length - 2] === state.body;

    state.translatingVariableDeclaration = translateDecl;
    walk.base.VariableDeclaration(node, state, c);
    state.translatingVariableDeclaration = false;

    if (!translateDecl) {
      return;
    }

    state.edit.replace(node.start, node.start + node.kind.length + 1, "void (");

    let decl;
    for (decl of node.declarations) {
      if (decl.init) {
        state.edit.insertBefore(decl, "(");
        state.edit.insertAfter(decl, ")");
      } else {
        // A declaration without an initializer (e.g. `var a;`) turns into
        // an assignment with undefined. Note that for destructuring
        // declarations, an initializer is mandatory, hence it is safe to just
        // assign undefined here.
        // TODO: if the declaration kind is 'var', this should probably be
        // hoisted, as this is perfectly legal javascript :/
        //   function() {
        //     console.log(foo);
        //     foo = 4;
        //     var foo;
        //   }
        state.edit.insertBefore(decl, "(");
        state.edit.insertAfter(decl, "= undefined)");
      }
    }

    // Insert after `decl` rather than node, otherwise the closing bracket
    // might end up wrapping a semicolon.
    state.edit.insertAfter(decl, ")");
  },

  VariableDeclarator(node, state, c) {
    walk.base.VariableDeclarator(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    if (node.id.type === "Identifier") {
      state.edit.insertBefore(node.id, `__global.`);
    }
  },

  ObjectPattern(node, state, c) {
    walk.base.ObjectPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const p of node.properties) {
      if (p.shorthand) {
        state.edit.insertAfter(p.value, `:__global.${p.value.name}`);
      } else if (p.value.type === "Identifier") {
        state.edit.insertBefore(p.value, `__global.`);
      }
    }
  },

  ArrayPattern(node, state, c) {
    walk.base.ArrayPattern(node, state, c);

    if (!state.translatingVariableDeclaration) {
      return;
    }

    for (const e of node.elements) {
      if (e.type === "Identifier") {
        state.edit.insertBefore(e, `__global.`);
      }
    }
  },

  // Don't do any translation inside function (etc.) bodies.
  FunctionExpression: noop,
  ArrowFunctionExpression: noop,
  MethodDefinition: noop
};

/* tslint:enable:object-literal-sort-keys*/

export class Transpiler {
  static topLevelRe = /__transpiled_top_level_\d+__/g;
  static sourcePositionRe =
    /(?:__transpiled_source_(\d+)__)(?::(\d+))?(?::(\d+))?/g;

  private counter = 0;
  private originalSources: { [id: string]: SourceFile } = {};
  private transpiledSources: { [id: string]: MappedString } = {};

  private parseWrappedSource(source: string) {
    // Parse javascript code which has been wrapped in an (async) function
    // expression, then find function body node.
    const root = acorn.parse(source, {
      ecmaVersion: 8,
      allowImportExportEverywhere: true
    });
    const functionExpression = root.body[0].expression;
    assert(functionExpression.type === "FunctionExpression");
    const body = functionExpression.body;
    return body;
  }

  // Transpiles a repl cell into an async function expression.
  // The returning string has the form:
  //   (async (global, import) => {
  //     ... cell statements
  //     return last_expression_result;
  //   })
  transpile(code: string, name: string): string {
    const id = `${++this.counter}`;
    const original: SourceFile = new SourceFile(name, code);

    // Wrap the source in an async function.
    let transpiled: MappedString = new MappedString().concat(
      `(async function __transpiled_top_level_${id}__`,
      `(__global, __import, console) {\n`,
      original,
      `\n})\n//# sourceURL=__transpiled_source_${id}__`
    );

    // Translate imports into async imports.
    let edit = new EditHelper(transpiled);
    let body = this.parseWrappedSource(transpiled.toString());
    walk.recursive(body, { edit }, importVisitors);
    transpiled = edit.getResult();

    // Translate variable declarations into global assignments.
    edit = new EditHelper(transpiled);
    body = this.parseWrappedSource(transpiled.toString());
    walkRecursiveWithAncestors(
      body,
      {
        body,
        edit,
        translatingVariableDeclaration: false
      },
      evalScopeVisitors
    );
    // If the last statement is an expression, turn it into a return statement.
    if (body.body.length > 0) {
      const last = body.body[body.body.length - 1];
      if (last.type === "ExpressionStatement") {
        edit.insertBefore(last, "return (");
        edit.insertAfter(last.expression, ")");
      }
    }
    transpiled = edit.getResult();

    // Store the transpilation result so we can map stack traces to their
    // untranspiled counterparts.
    this.originalSources[id] = original;
    this.transpiledSources[id] = transpiled;

    return transpiled.toString();
  }

  formatErrorStack(error: Error) {
    let msg = error.stack;

    // Find the frame that corresponds with the async function wrapper that was
    // added around the source code. Rename it to "top level" and cut the stack
    // after it.
    const frames = [];
    for (const frame of msg.split(/\r?\n/)) {
      if (!Transpiler.topLevelRe.test(frame)) {
        frames.push(frame);
      } else {
        frames.push(frame.replace(Transpiler.topLevelRe, "top level"));
        break;
      }
    }
    msg = frames.join("\n");

    // To the extent possible, map locations in the transpiled source code
    // to locations in the original source.
    // Not all browsers provide the same level of detail. Safari for example
    // doesn't provide line/column numbers.
    msg = msg.replace(
      Transpiler.sourcePositionRe,
      (s: string, id: string, line?, column?) => {
        // Note that line/columns numbers in the stack trace are 1-based, but
        // MappedString positions are zero-based.
        if (line != null) --line;
        if (column != null) --column;
        const original = this.originalSources[id];
        if (!original) return s;
        s = original.name;
        const pos = this.transpiledSources[id].getCharNearLC(line, column);
        if (!pos) return s;
        if (line == null || pos.line == null) return s;
        s += `:${pos.line + 1}`;
        if (column == null || pos.column == null) return s;
        s += `:${pos.column + 1})`;
        return s;
      }
    );

    // Some browsers (Chrome) include the error message in the stack, whil
    // others (Firefox) don't.
    if (msg.indexOf(error.message) === -1) {
      msg = `${error.constructor.name}: ${error.message}\n${msg}`;
    }
    return msg;
  }

  getEntryPoint(): string | null {
    // Create an error. In some browsers, an error doesn't have it's stack
    // trace captured unless it's thrown, so that's how we do it.
    let stack, stackTraceLimit;
    try {
      stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = Infinity;
      throw new Error();
    } catch (e) {
      stack = e.stack;
      Error.stackTraceLimit = stackTraceLimit;
    }

    // See if we can find the name of the async function wrapper in the stack.
    // In safari this might be the only clue we'll ever get.
    const match = Transpiler.topLevelRe.exec(stack);
    if (match) {
      const file: SourceFile = this.originalSources[match[1]];
      if (file) return file.name;
    }

    // Scan the stack for filenames known to be generated by the transpiler.
    for (const line of stack.split("\n").reverse()) {
      const match = Transpiler.sourcePositionRe.exec(line);
      if (!match) continue;
      const file: SourceFile = this.originalSources[match[1]];
      if (file) return file.name;
    }

    return null;
  }
}

interface Position {
  line?: number;
  column?: number;
}

class MappedChar implements Position {
  readonly char: string;
  readonly line?: number;
  readonly column?: number;

  constructor(char: string, { line, column }: Position = {}) {
    this.char = char;
    this.line = line;
    this.column = column;
  }
}

type MappedStringLike = string | MappedChar[] | MappedString;

class MappedString extends Array<MappedChar> {
  static EMPTY = new MappedString();

  static convert(str: any, pos: Position = {}): MappedString {
    if (str instanceof MappedString) {
      return str;
    } else if (str instanceof Array) {
      return new MappedString(str);
    } else {
      return new MappedString(
        Array.from("" + str).map(char => new MappedChar(char, pos))
      );
    }
  }

  constructor(chars: number | string | MappedChar[] = [], pos?: Position) {
    if (typeof chars === "number") {
      super();
    } else if (typeof chars === "string") {
      super(...Array.from(chars).map(char => new MappedChar(char, pos)));
    } else {
      super(...chars);
    }
  }

  concat(...parts: any[]): MappedString {
    parts = parts.map(part => MappedString.convert(part));
    return Array.prototype.concat.apply(this, parts);
  }

  getCharNearLC(line = 0, column = 0): MappedChar | null {
    let i = 0;
    let char: MappedChar = null;
    while (line > 0 && i < this.length) {
      char = this[i++];
      if (char.char === "\n") --line;
    }
    while (column > 0 && i < this.length) {
      char = this[i++];
      if (char.char === "\n") break;
      --column;
    }
    return char;
  }

  slice(start: number, end?: number): MappedString {
    return Array.prototype.slice.call(this, start, end);
  }

  split(): MappedString[] {
    // This function the same as String.prototype.split(""), in other words it,
    // returns an array of MappedStrings with length 1.
    return Array.from(this).map(c => new MappedString([c]));
  }

  toString(): string {
    return this.reduce((str, c) => str + c.char, "");
  }
}

class SourceFile extends MappedString {
  constructor(readonly name: string, source: string) {
    super();

    let line = 0;
    let column = 0;

    for (const char of source) {
      this.push(new MappedChar(char, { line, column }));
      if (char === "\n") {
        ++line;
        column = 0;
      } else {
        ++column;
      }
    }
  }
}

class EditHelper {
  private index: MappedString[];

  constructor(source: MappedStringLike) {
    this.index = MappedString.convert(source).split();
  }

  getResult(): MappedString {
    return new MappedString().concat(...this.index);
  }

  prepend(str: MappedStringLike): void {
    let mstr = MappedString.convert(str);
    if (this.index.length > 0) {
      mstr = mstr.concat(this.index[0]);
    }
    this.index[0] = mstr;
  }

  append(str: MappedStringLike): void {
    this.index.push(MappedString.convert(str));
  }

  replace(start, end, str: MappedStringLike): void {
    this.index[start] = MappedString.convert(str, this.index[start][0]);
    for (let i = start + 1; i < end; i++) {
      this.index[i] = MappedString.EMPTY;
    }
  }

  insertBefore({ start }, str: MappedStringLike): void {
    const mstr = MappedString.convert(str, this.index[start][0]);
    this.index[start] = mstr.concat(this.index[start]);
  }

  insertAfter({ end }, str: MappedStringLike): void {
    const mstr = MappedString.convert(str, this.index[end][0]);
    this.index[end - 1] = this.index[end - 1].concat(mstr);
  }
}
