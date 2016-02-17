const fs = require('fs');
const cofs = require('co-fs-extra');
const path = require('path');
const shortid = require('shortid');
const mime = require('mime-types');
const cache = require('lru-cache')({ maxAge: 31556926 });
const readChunk = require('read-chunk');
const fileType = require('file-type');
const thunkify = require('thunkify');
const multiline = require('multiline');
const imagemin = require('imagemin');
const imageminPlugins = {
    optipng: require('imagemin-optipng'),
    pngquant: require('imagemin-pngquant'),
    svgo: require('imagemin-svgo'),
    gifsicle: require('imagemin-gifsicle'),
    mozjpeg: require('imagemin-mozjpeg')
};

const koa = require('koa');
const app = koa();
const router = require('koa-router')();

var config;
try {
    var config = require('../config');
} catch (e) {
    console.error(e);
    var config = {};
}

const tmpDir = config.tmpDir || path.join(process.cwd(), '/tmp');
const uploadsDir = config.uploadsDir || path.join(process.cwd(), '/uploads');

const isProduction = process.env.NODE_ENV === "production";

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
    try {
        fs.mkdirSync(tmpDir);
    } catch (e) {
        console.error("Failed to create tmpDir:", tmpDir);
    }
}

if (!fs.existsSync(uploadsDir)) {
    try {
        fs.mkdirSync(uploadsDir);
    } catch (e) {
        console.error("Failed to create tmpDir:", uploadsDir);
    }
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

    if (404 !== this.status) return;

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
    if (yield this.cashed()) {
        return;
    }
    this.set('Content-Type', 'text/html');
    this.set('Last-Modified', new Date());
    this.set('Cache-Control', 'public, max-age=31556926');
    if (isProduction) {
        this.body = multiline.stripIndent(function(){/*
            <!doctype html>
            <html>
                <head>
                    <title></title>
                </head>
                <body>
                    <h1>Hi!</h1>
                </body>
            </html>
        */});
    } else {
        this.body = multiline.stripIndent(function(){/*
            <!doctype html>
            <html>
                <head>
                    <title></title>
                </head>
                <body>
                    <h1>Test</h1>
                    <form action="/upload" enctype="multipart/form-data" method="post">
                    <input type="file" name="imagedata"><br>
                    <button type="submit">Upload</button>
                </body>
            </html>
        */});
    }
});

function moveFile(source, dest, cb) {
    var readStream = fs.createReadStream(source);
    var writeStream = fs.writeStream(dest);
    readStream.pipe(writeStream);
    readStream.on('end', function () {
        fs.unlinkSync(source);
        cb();
    });
    readStream.on('error', function (err) {
        cb(err);
    });
}

function optimizeImage(source, dest, cb) {
    console.log("Optimizing file:", source);
    var buffer = readChunk.sync(source, 0, 262);
    var type = fileType(buffer);
    var optimizer = new imagemin()
        .src(source)
        .dest(path.join(tmpDir, '/opt'));

    switch (type.ext) {
        case 'png':
            optimizer.use(imageminPlugins.pngquant({
                quality: '65-80', 
                speed: 3
            }));
            optimizer.use(imageminPlugins.optipng({
                optimizationLevel: 4
            }));
        break;

        case 'jpg':
        case 'jpeg':
            optimizer.use(imageminPlugins.mozjpeg({
                quality: 80
            }));
        break;

        case 'gif':
            optimizer.use(imageminPlugins.gifsicle({
                interlaced: true
            }));
        break;

        case 'svg':
            optimizer.use(imageminPlugins.svgo()());
        break;
    }

    optimizer.run(function (err, files) {
        moveFile(
            err ? path.join(tmpDir, '/opt', path.basename(source)) : source,
            dest,
            cb
        );
    });
}

router.post('/upload', bodyParser, function *(next) {
    var upload = this.request.body.files.imagedata;
    if (!upload) {
        this.status = 400;
        yield next;
        return;
    }
    var id = shortid.generate();
    var filePath = path.join(uploadsDir, id);
    yield thunkify(optimizeImage)(upload.path, filePath);
    console.log('Saved file', id);
    this.status = 200;
    this.body = (this.request.protocol || 'http') + '://' + this.request.host + '/' + id + '.png';
    this.set('X-Gyazo-Id', id);
    yield next;
});

router.get('image', /^\/([0-9a-zA-Z_\-]+)(?:\.jpg|\.gif|\.png|\.bmp)?$/, function *(next) {
    console.log('GET', this.params[0]);
    if (yield this.cashed()) {
        return;
    }
    var file = path.join(uploadsDir, this.params[0]);
    if (yield cofs.exists(file)) {
        var buffer = readChunk.sync(file, 0, 262);
        var type = fileType(buffer);
        if (['png', 'jpg', 'bmp', 'gif', 'svg'].indexOf(type.ext) != -1) {
            this.set('Last-Modified', new Date());
            this.set('ETag', this.params[0]);
            this.set('Cache-Control', 'max-age=31556926');
            this.status = 200;
            this.type = type.mime;
            this.body = fs.createReadStream(file);
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
