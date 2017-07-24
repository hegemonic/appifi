const path = require('path')
const fs = require('fs')
const child = require('child_process')
const stream = require('stream')
const mkdirp = require('mkdirp')
const rimraf = require('rimraf')

const source = `
// begin embedded code

const fs = require('fs')
const crypto = require('crypto')
const hash = crypto.createHash('sha256')

let filePath, offset, fd
let length = 0
let totalRead = 0
let buffers = []
let stopped = false
let readFinished = false
let debug = false

// start: Object: { filePath, offset }
// number: new bytes written, that is, safe to read
// string: any string will terminate
process.on('message', message => {
  if (typeof message === 'object') {
    if (message.debug === true) debug = true
    if (debug) console.log('-> ', message)
    filePath = message.filePath
    fd = fs.openSync(filePath, 'r') 
    offset = message.offset || 0
  } else if (typeof message === 'number') {
    length += message
  } else if (typeof message === 'string') {
    stopped = true
  }
})

// don't set position to null !!!
// fs.read(fd, buffer, offset, length, position, callback)

const readLoop = () => {
  if (length === 0) return setImmediate(readLoop)
  if (length === totalRead) {
    if (stopped) {
      readFinished = true
      return  // end loop
    } else {
      return setImmediate(readLoop) // next 
    }
  }

  let len = length - totalRead
  process.send(len)
  let buf = Buffer.allocUnsafe(length - totalRead)
  let pos = offset + totalRead
  fs.read(fd, buf, 0, len, pos, (err, bytesRead, buffer) => {
    if (err) process.exit(1)
    if (bytesRead !== 0) {
      totalRead += bytesRead
      buffers.push(buffer.slice(0, bytesRead))
    }
    setImmediate(readLoop)
  })
}

const hashLoop = () => {
  if (buffers.length === 0) {
    if (readFinished) {
      process.send({
        bytesRead: totalRead, 
        digest: hash.digest('hex')
      })
      return process.exit(0)
    } 
  } else {
    if (debug) console.log(buffers.reduce((sum, buf) => sum + buf.length, 0))
    buffers.forEach(buf => hash.update(buf))
    buffers = []
  }
  setImmediate(hashLoop)
}

readLoop()
hashLoop()

// end embedded code
`

const Promise = require('bluebird')
const dirPath = path.join('/tmp', '646af000-8406-4c7a-bfb9-7e83b8a20418')
const modulePath = path.join(dirPath, 'tailhash.js')

rimraf.sync(dirPath)
mkdirp.sync(dirPath)
fs.writeFileSync(modulePath, source)

const K = x => y => x

// const 

// child -> parent message
// number -> how many 

// this class extends writable stream, so it does NOT fire error or finish directly

const Mixin = base => class extends base {

  constructor(...args) {
    super(...args)
    this._untils = []
  }

  async untilAsync (predicate, ignore) {
    if (predicate()) return
    return new Promise((resolve, reject) => this._untils.push({ 
      predicate, 
      resolve, 
      reject: ignore ? null : reject
    }))
  }

  _until () {
    this._untils = this._untils.reduce((arr, x) => (this.error && x.reject) 
      ? K(arr)(x.reject())
      : x.predicate() 
        ? K(arr)(x.resolve()) 
        : [...arr, x], [])
  }

  observe (name, value) {
    let _name = '_' + name
    this[_name] = value
    Object.defineProperty(this, name, {
      get: function () {
        return this[_name]
      },
      set: function (x) { 
        if (this[_name]) return // TODO
        console.log('observe set', name, x)
        this[_name] = x
        process.nextTick(() => this._until())
      }
    })
  }
}

class TailHash extends Mixin(stream.Writable) {

  constructor(ws, offset) {
    super({ highWaterMark: 1024 * 1024 })
    this.observe('error', null)
    this.observe('wsFinished', false)
    this.observe('tailExited', false)
    this.observe('finalize', null)
   
    this.bytesWritten = 0
    this.bytesRead = 0
    this.pendingRead = 0

    this.ws = ws
    this.ws.on('error', err => this.error = err)
    this.ws.on('finish', () => this.wsFinished = true)

    this.tail = child.fork(modulePath)
    this.tail.on('message', message => {
      if (typeof message === 'object') {
        this.pendingRead = 0
        if (message.bytesRead === this.bytesWritten) {
          this.digest = message.digest
        } else {
          this.error = new Error('bytes written and read mismatch')
        }
      }
      else if (typeof message === 'number') {
        console.log('pending read', message)
        this.pendingRead = message
      }
      else {
        this.error = new Error('invalid message from child process')
      }
    })
    this.tail.on('error', err => this.error = err)
    this.tail.on('exit', () => this.tailExited = true)
    this.tail.send({ filePath: ws.path, offset })

    ;(async () => {

      try {
        await this.untilAsync(() => this.finalize)
        this.ws.end()
        await this.untilAsync(() => this.wsFinished)
        this.tail.send('final')
        await this.untilAsync(() => this.tailExited)
      } catch (e) {
        this.error = e
        this.ws.end()
        this.fork.kill()
      } finally {
        await this.untilAsync(() => this.finalize && this.wsFinished && this.tailExited, true)
        this.finalize(this.error)
      }
    })().then(x => x)
  }

  _write(chunk, encoding, callback) {
    if (this.error) return callback(this.error)

    this.ws.write(chunk, encoding, () => {
      if (this.error) return callback(this.error)
      this.bytesWritten += chunk.length
      this.tail.send(chunk.length)
      callback()
    })
  } 

  _writev(chunks, callback) {
    if (this.error) return callback(this.error)

    let totalLength = chunks.reduce((l, { chunk }) => l + chunk.length, 0)
    chunks.forEach(({chunk, encoding}, index) => {
      if (index === chunks.length - 1) { // last one
        this.ws.write(chunk, encoding, () => {
          if (this.error) return callback(this.error)
          this.bytesWritten += totalLength
          this.tail.send(totalLength)
          callback()
        }) 
      } else {
        this.ws.write(chunk, encoding)
      }
    })
  }

  _final(callback) {
    this.finalize = callback
  }
}

const createAppendStream = (filePath, callback) => {

  fs.lstat(filePath, (err, stat) => {

    let offset
    if (err) {
      if (err.code !== 'ENOENT') return callback(err)
      offset = 0
    } else {
      if (!stat.isFile()) return callback(new Error('not a file'))
      offset = stat.size
    }

    // making sure file exists when tail process begins
    fs.open(filePath, 'a', (err, fd) => {
      if (err) return err

      let ws = fs.createWriteStream(filePath, { fd })
      let append = new TailHash(ws, offset)
      callback(null, append)
    })
  })
}

mkdirp.sync('tmptest')

createAppendStream('tmptest/output', (err, as) => {

  if (err) {
    console.log(err)
    return
  }

  as.on('finish', () => console.log('[as finish]', as.digest, as.bytesWritten))
  fs.createReadStream('testdata/ubuntu.iso').pipe(as) 
})









