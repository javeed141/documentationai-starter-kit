const fs = require('fs');
const path = require('path');

class ReadmeComponentFinder {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.findings = [];
  }

  getAllMdxFiles(dir = this.workspaceRoot, files = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'scripts') {
        continue;
      }
      
      if (entry.isDirectory()) {
        this.getAllMdxFiles(fullPath, files);
      } else if (entry.name.endsWith('.mdx')) {
        files.push(fullPath);
      }
    }
    
    return files;
  }

  scanFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.workspaceRoot, filePath);
    const lines = content.split('\n');
    const findings = [];

    const patterns = [
      { pattern: /\[block:embed\]/g, type: 'embed', description: 'Readme embed block' },
      { pattern: /\[block:image\]/g, type: 'image', description: 'Readme image block' },
      { pattern: /\[block:parameters\]/g, type: 'parameters', description: 'Readme parameters table' },
      { pattern: /\[block:api-header\]/g, type: 'api-header', description: 'Readme API header' },
      { pattern: /\[block:code\]/g, type: 'code', description: 'Readme code block' },
      { pattern: /\[block:callout\]/g, type: 'callout', description: 'Readme callout' },
      { pattern: /\[block:html\]/g, type: 'html', description: 'Readme HTML block' },
      { pattern: /needs manual review/gi, type: 'manual-review', description: 'Flagged for manual review' },
      { pattern: /Try [Ii]t [Oo]ut/g, type: 'try-it', description: 'Try It Out reference' },
      { pattern: /rdme-|readme-|ReadMe/g, type: 'readme-component', description: 'Readme component' },
    ];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      for (const { pattern, type, description } of patterns) {
        pattern.lastIndex = 0;
        if (pattern.test(line)) {
          findings.push({
            file: relativePath,
            line: lineNum,
            type,
            description,
            content: line.trim().substring(0, 100)
          });
        }
      }
    }

    return findings;
  }

  scanAll() {
    const files = this.getAllMdxFiles();
    const allFindings = [];
    const stats = {
      totalFiles: files.length,
      filesWithFindings: 0,
      byType: {}
    };

    for (const file of files) {
      const findings = this.scanFile(file);
      
      if (findings.length > 0) {
        stats.filesWithFindings++;
        allFindings.push(...findings);
        
        for (const finding of findings) {
          stats.byType[finding.type] = (stats.byType[finding.type] || 0) + 1;
        }
      }
    }

    return { stats, findings: allFindings };
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const finder = new ReadmeComponentFinder(workspaceRoot);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║         Readme Component Finder                            ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const { stats, findings } = finder.scanAll();

  console.log('Statistics:');
  console.log(`  Total files scanned: ${stats.totalFiles}`);
  console.log(`  Files with findings: ${stats.filesWithFindings}`);
  console.log('\nFindings by type:');
  
  for (const [type, count] of Object.entries(stats.byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  if (findings.length > 0) {
    console.log('\n' + '─'.repeat(60));
    console.log('DETAILED FINDINGS:');
    console.log('─'.repeat(60));

    const byFile = {};
    for (const finding of findings) {
      if (!byFile[finding.file]) byFile[finding.file] = [];
      byFile[finding.file].push(finding);
    }

    for (const [file, fileFindings] of Object.entries(byFile)) {
      console.log(`\n${file}:`);
      for (const finding of fileFindings) {
        console.log(`  Line ${finding.line} [${finding.type}]: ${finding.description}`);
        console.log(`    "${finding.content}${finding.content.length >= 100 ? '...' : ''}"`);
      }
    }
  }

  const outputPath = path.join(__dirname, 'readme-component-findings.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    stats,
    findings
  }, null, 2));

  console.log(`\nResults saved to: ${outputPath}`);

  return { stats, findings };
}

module.exports = { ReadmeComponentFinder, main };

if (require.main === module) {
  main().catch(console.error);
}
