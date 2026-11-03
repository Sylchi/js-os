// JavaScript implementation of the runtime
// This will be assembled to x86-64 automatically

// Memory layout (chosen addresses)
const CODE_BASE = 0x401000;
const STACK_BASE = 0x7FFF0000;

// Registers we'll use
const REGS = {
  R12: 'input_cursor',
  R13: 'input_end', 
  R14: 'output_cursor',
  R15: 'output_end',
  RAX: 'scratch1',
  RBX: 'scratch2',
  RCX: 'scratch3',
  RDX: 'scratch4',
  R8: 'scratch5',
  R9: 'scratch6',
  R10: 'scratch7',
  R11: 'scratch8',
};

// Main execution loop
function mainLoop() {
  while (R12 < R13) {
    const byte = loadByte(R12);
    R12++;
    
    if (byte <= 32) {
      // Skip whitespace/control chars
      continue;
    }
    
    // Hash identifier
    let hash = FNV_OFFSET;
    const start = R12 - 1;
    
    while (R12 < R13) {
      const b = loadByte(R12);
      if (b <= 32 || b === 46 || b === 40 || b === 61 || b === 59 || b === 44) {
        break;
      }
      hash = (hash ^ b) * FNV_PRIME;
      R12++;
    }
    
    // Dispatch based on hash
    if (hash === HASH_CONSOLE) {
      handleConsole();
    } else if (hash === HASH_LET) {
      handleLet();
    } else if (hash === HASH_ARR) {
      handleArray();
    } else {
      // Variable reference
      handleVariable(hash);
    }
    
    // Skip to statement end
    skipToEnd();
  }
}

function handleConsole() {
  // Skip whitespace and '.'
  skipWhitespace();
  expectByte(46); // '.'
  
  // Hash method name
  let hash = FNV_OFFSET;
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b === 40) break; // '('
    hash = (hash ^ b) * FNV_PRIME;
    R12++;
  }
  
  if (hash === HASH_LOG) {
    handleConsoleLog();
  }
}

function handleConsoleLog() {
  expectByte(40); // '('
  skipWhitespace();
  
  // Parse argument
  const argByte = loadByte(R12);
  
  if (argByte === 34) {
    // String literal
    handleStringLiteral();
  } else if (argByte >= 48 && argByte <= 57) {
    // Number literal
    handleNumberLiteral();
  } else {
    // Variable reference
    handleVariableArg();
  }
  
  skipToParen();
}

function handleLet() {
  skipWhitespace();
  
  // Hash variable name
  let hash = FNV_OFFSET;
  const nameStart = R12;
  
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b === 61) break; // '='
    hash = (hash ^ b) * FNV_PRIME;
    R12++;
  }
  
  // Skip '='
  expectByte(61);
  skipWhitespace();
  
  // Parse value
  const valueByte = loadByte(R12);
  if (valueByte >= 48 && valueByte <= 57) {
    // Number literal
    let value = 0;
    while (R12 < R13) {
      const b = loadByte(R12);
      if (b < 48 || b > 57) break;
      value = value * 10 + (b - 48);
      R12++;
    }
    
    // Store in XMM register based on hash
    const slot = hash & 7;
    storeToXMM(slot, value);
  }
}

function handleArray() {
  skipWhitespace();
  
  // Hash array name
  let hash = FNV_OFFSET;
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b === 61) break;
    hash = (hash ^ b) * FNV_PRIME;
    R12++;
  }
  
  expectByte(61); // '='
  skipWhitespace();
  expectByte(91); // '['
  
  // Parse array elements
  let index = 0;
  while (R12 < R13) {
    skipWhitespace();
    const b = loadByte(R12);
    
    if (b === 93) { // ']'
      R12++;
      break;
    }
    
    if (b === 44) { // ','
      R12++;
      continue;
    }
    
    if (b >= 48 && b <= 57) {
      // Number
      let value = 0;
      while (R12 < R13) {
        const d = loadByte(R12);
        if (d < 48 || d > 57) break;
        value = value * 10 + (d - 48);
        R12++;
      }
      
      // Store in XMM3-5 (array slots)
      if (index < 3) {
        storeToXMM(3 + index, value);
      }
      index++;
    }
  }
}

function handleVariable(hash) {
  // This is just a variable reference, skip to end
  skipToEnd();
}

function handleVariableArg() {
  // Hash variable name
  let hash = FNV_OFFSET;
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b === 41) break; // ')'
    if (b <= 32) {
      R12++;
      continue;
    }
    hash = (hash ^ b) * FNV_PRIME;
    R12++;
  }
  
  // Load from XMM register
  const slot = hash & 7;
  const value = loadFromXMM(slot);
  
  // Print the value
  printNumber(value);
}

function handleStringLiteral() {
  R12++; // skip opening quote
  const start = R12;
  
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b === 34) { // closing quote
      // Print string from start to R12
      printString(start, R12 - start);
      R12++;
      break;
    }
    R12++;
  }
}

function handleNumberLiteral() {
  let value = 0;
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b < 48 || b > 57) break;
    value = value * 10 + (b - 48);
    R12++;
  }
  printNumber(value);
}

function skipWhitespace() {
  while (R12 < R13) {
    const b = loadByte(R12);
    if (b > 32) break;
    R12++;
  }
}

function skipToEnd() {
  while (R12 < R13) {
    const b = loadByte(R12);
    R12++;
    if (b === 59 || b === 10) { // ';' or '\n'
      break;
    }
  }
}

function skipToParen() {
  while (R12 < R13) {
    const b = loadByte(R12);
    R12++;
    if (b === 41) break; // ')'
  }
}

function expectByte(expected) {
  while (R12 < R13) {
    const b = loadByte(R12);
    R12++;
    if (b === expected) return;
    if (b > 32) {
      // Error: unexpected byte
      return;
    }
  }
}

function loadByte(addr) {
  // In actual assembly, this becomes: load8 REG.RAX, addr, 0
  return 0;
}

function storeToXMM(slot, value) {
  // In actual assembly, this becomes: movq_xmm_r64 XMM(slot), value
}

function loadFromXMM(slot) {
  // In actual assembly, this becomes: movq_r64_xmm value, XMM(slot)
  return 0;
}

function printString(start, length) {
  // sys_write(stdout=1, buf=start, len=length)
  // RAX=1, RDI=1, RSI=start, RDX=length
}

function printNumber(value) {
  // Convert to string and print
}

// Constants
const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;

const HASH_CONSOLE = 0x8407807e8cea154an;
const HASH_LOG = 0x125073191daf5431n;
const HASH_LET = 0x127284191dcc577an;
const HASH_ARR = 0xe756b1190570b338n;

export { mainLoop, CODE_BASE, STACK_BASE };
