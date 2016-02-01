const fs = require('co-fs-extra');
const path = require('path');
const shortid = require('shortid');
const mime = require('mime-types');
const cache = require('lru-cache')();
const readChunk = require('read-chunk');
const fileType = require('file-type');
const thunkify = require('thunkify');
const multiline = require('multiline');
const imgopti = require('imgopti');

const koa = require('koa');
const app = koa();
const router = require('koa-router')();

const tmpDir = path.join(process.cwd(), '/tmp');
const uploadsDir = path.join(process.cwd(), '/uploads');

const bodyParser = require('koa-body')({ 
    multipart: true,
    jsonLimit: "10mb",
    formLimit: "10mb",
    textLimit: "1mb",
    formidable: {
        uploadDir: tmpDir
    }
});

if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir);
}

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

app.use(require('koa-cash')({
    maxAge: 31556926,
    get (key) {
        return cache.get(key);
    },
    set (key, value, maxAge) {
        return cache.set(key, value);
    }
}));

app.use(function *pageNotFound(next){
    yield next;

    if (404 != this.status) return;

    // we need to explicitly set 404 here
    // so that koa doesn't assign 200 on body=
    this.status = 404;

    switch (this.accepts('html', 'json')) {
        case 'html':
            this.type = 'html';
            this.body = '<h1>404 File Not Found</h1>';
        break;
        case 'json':
            this.body = {
                status: 404,
                message: 'File Not Found'
            };
        break;
        default:
            this.type = 'text';
            this.body = 'File Not Found';
    }
});

router.get('/', function *(next) {
  this.set('Content-Type', 'text/html');
  this.body = multiline.stripIndent(function(){/*
      <!doctype html>
      <html>
          <body>
              <h1>Hi!</h1>
          </body>
      </html>
  */});
});

function optimizeImage(file) {
    var optimizer = new imgopti({
        input: [], // directory or file
        output: null, // output directory, if not , overwrite original file and save original file like xxx-old.xxx
        matchRules: [ // image filter rules
            '*.jpeg',
            '*.jpg',
            '*.png',
            '*.gif'
        ],
        lossy: 20, // default value: 20
        force: 1, //  overwrite original file and  do not save original image
        onFileProcessed: function (newFile, oldFile) { // callback when a file is processed
            console.log("Optimized file:", file);
        },
        onComplete: function(count) { // callback when all files are processed

        }
    });
    optimizer.process();
};

router.post('/upload', bodyParser, function *(next) {
    var upload = this.request.body.files.imagedata;
    if (!upload) {
        this.status = 400;
        yield next;
    }
    var id = shortid.generate();
    var filePath = path.join(uploadsDir, id);
    yield fs.rename(upload.path, filePath);
    optimizeImage(filePath);
    console.log('Saved file', id);
    this.status = 200;
    this.body = (this.request.protocol || 'http') + '://' + this.request.host + '/' + id + '.png';
    this.set('X-Gyazo-Id', id);
    yield next;
});

router.get('image', /^\/([0-9a-zA-Z_\-]+)(?:\.jpg|\.gif|\.png|\.bmp)?$/, function *(next) {
    console.log('GET', this.params[0]);
    if (yield this.cashed()) return;
    var file = path.join(uploadsDir, this.params[0]);
    if (yield fs.exists(file)) {
        var buffer = readChunk.sync(file, 0, 262);
        var type = fileType(buffer);
        if (['png', 'jpg', 'bmp', 'gif'].indexOf(type.ext) != -1) {
            this.status = 200;
            this.type = type.mime;
            this.body = yield fs.createReadStream(file);
        } else {
            this.status = 500;
        }
    } else {
        this.status = 404;
    }
    yield next;
});

app.use(router.routes());
const PORT = process.env.PORT || 3131;
app.listen(PORT, function () {
    console.log("Listening to", PORT);
});
