const fs = require('fs');
const path = require('path');

class ImageAltFixer {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this.fixedCount = 0;
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

  generateAltText(src, filePath) {
    let altText = '';
    
    const filename = src.split('/').pop().split('?')[0];
    
    const cleanName = filename
      .replace(/\.[^.]+$/, '')
      .replace(/[-_]/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b[a-f0-9]{8,}\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (cleanName && cleanName.length > 3 && !/^[a-f0-9]+$/i.test(cleanName)) {
      altText = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
    } else {
      const pageTitle = path.basename(filePath, '.mdx')
        .replace(/[-_]/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2');
      altText = `Screenshot from ${pageTitle}`;
    }

    return altText;
  }

  fixFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(this.workspaceRoot, filePath);
    let modified = false;
    let fileFixCount = 0;

    const imageRegex = /<Image\s+([^>]*?)(\s*\/?>)/g;
    
    content = content.replace(imageRegex, (match, attrs, closing) => {
      const srcMatch = attrs.match(/src=["']([^"']+)["']/);
      const altMatch = attrs.match(/alt=["']([^"']*)["']/);
      
      if (!srcMatch) return match;
      
      const src = srcMatch[1];
      const currentAlt = altMatch ? altMatch[1] : null;

      if (currentAlt === null || currentAlt === '') {
        const newAlt = this.generateAltText(src, relativePath);
        
        if (altMatch) {
          const newAttrs = attrs.replace(/alt=["'][^"']*["']/, `alt="${newAlt}"`);
          modified = true;
          fileFixCount++;
          return `<Image ${newAttrs}${closing}`;
        } else {
          modified = true;
          fileFixCount++;
          return `<Image ${attrs} alt="${newAlt}"${closing}`;
        }
      }
      
      return match;
    });

    if (modified) {
      fs.writeFileSync(filePath, content);
      this.fixedCount += fileFixCount;
      console.log(`  Fixed ${fileFixCount} images in ${relativePath}`);
    }

    return fileFixCount;
  }

  fixAll() {
    const files = this.getAllMdxFiles();
    console.log(`Scanning ${files.length} MDX files for images with missing alt text...\n`);
    
    let filesFixed = 0;
    
    for (const file of files) {
      const count = this.fixFile(file);
      if (count > 0) filesFixed++;
    }

    return {
      filesFixed,
      imagesFixed: this.fixedCount
    };
  }
}

async function main() {
  const workspaceRoot = path.resolve(__dirname, '..');
  const fixer = new ImageAltFixer(workspaceRoot);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║           Image Alt Text Fixer                             ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  const { filesFixed, imagesFixed } = fixer.fixAll();

  console.log('\n' + '═'.repeat(60));
  console.log(`Fixed ${imagesFixed} images in ${filesFixed} files`);
  console.log('═'.repeat(60));

  return { filesFixed, imagesFixed };
}

module.exports = { ImageAltFixer, main };

if (require.main === module) {
  main().catch(console.error);
}
