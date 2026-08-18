'use strict';

/*
 * Adds or removes only this helper's marked block in a CloudPanel Twig file.
 * Existing CloudPanel markup and blocks belonging to other helpers are never
 * replaced. Re-running the installer replaces our previous block in place.
 */
const fs = require('fs');

const BEGIN = '{# BEGIN cloudpanel-pgmanager-helper #}';
const END = '{# END cloudpanel-pgmanager-helper #}';
const target = process.argv[2];
const blockFile = process.argv[3];
const helperPort = process.argv[4];

if(!target || !blockFile) {
    console.error('Usage: patch-template.js <template> <block-file|--remove> [helper-port]');
    process.exit(1);
}

let text;

try {
    text = fs.readFileSync(target, 'utf8');
} catch(error) {
    console.error(`Cannot read template: ${target}`);
    process.exit(1);
}

const beginIndex = text.indexOf(BEGIN);
const endIndex = text.indexOf(END);

if(beginIndex !== -1 && endIndex !== -1 && endIndex > beginIndex) {
    let cut = endIndex + END.length;
    if(text[cut] === '\r') cut++;
    if(text[cut] === '\n') cut++;
    text = text.slice(0, beginIndex) + text.slice(cut);
} else if(beginIndex !== -1 || endIndex !== -1) {
    console.error(`Template has an unbalanced cloudpanel-pgmanager-helper block: ${target}`);
    process.exit(1);
}

if(blockFile === '--remove') {
    fs.writeFileSync(target, text);
    process.exit(0);
}

let block;

try {
    block = fs.readFileSync(blockFile, 'utf8');
} catch(error) {
    console.error(`Cannot read block file: ${blockFile}`);
    process.exit(1);
}

if(helperPort) block = block.replace(/__PGMANAGER_HELPER_PORT__/g, helperPort);

if(!block.includes(BEGIN) || !block.includes(END)) {
    console.error(`Block file is missing its markers: ${blockFile}`);
    process.exit(1);
}

const endblockPattern = /\{%-?\s*endblock\s*-?%\}/g;
let lastEndblock = -1;
let match;

while((match = endblockPattern.exec(text)) !== null) lastEndblock = match.index;

if(lastEndblock === -1) {
    console.error(`Could not find a Twig endblock in: ${target}`);
    process.exit(1);
}

text = text.slice(0, lastEndblock) + block.trimEnd() + '\n' + text.slice(lastEndblock);
fs.writeFileSync(target, text);
