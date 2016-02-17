const path = require('path');
module.exports = {
    tmpDir: process.env.TMP_DIR || path.join(process.cwd(), '/tmp'),
    uploadsDir: process.env.STORAGE_DIR || path.join(process.cwd(), '/uploads')
};
