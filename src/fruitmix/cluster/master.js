const path = require('path')
const mkdirpAsync = Promise.promisify(require('mkdirp'))

import config from './config'
import createModelService from '../models/modelService'
import { createDocumentStoreAsync } from '../lib/documentStore'
import FileData from '../file/fileData'
import { createFileShareStore, createMediaShareStore } from '../lib/shareStore'
import { createFileShareData } from '../file/fileShareData'
import { createFileShareService } from '../file/fileShareService'
import FileService from '../file/fileService'

const makeDirectoriesAsync = async froot => {

  await mkdirpAsync(froot)

  const join = sub => path.join(froot, sub)

  await Promise.all([
    mkdirpAsync(join('models')),
    mkdirpAsync(join('drives')),
    mkdirpAsync(join('documents')),
    mkdirpAsync(join('fileShare')),
    mkdirpAsync(join('fileShareArchive')),
    mkdirpAsync(join('mediashare')),
    mkdirpAsync(join('mediashareArchive')),
    mkdirpAsync(join('mediatalk')),
    mkdirpAsync(join('mediatallArchive')),
    mkdirpAsync(join('thumbnail')),
    mkdirpAsync(join('log')),
    mkdirpAsync(join('etc')),
    mkdirpAsync(join('smb')),
    mkdirpAsync(join('tmp'))
  ])
}

export default async () => {

	const froot = config.path

  await makeDirectoriesAsync(froot)

	const modelService = createModelService(froot)
  const modelData = modelService.modelData
	const docStore = await createDocumentStoreAsync(froot)
	const fileData = new FileData(path.join(froot, 'drives'), modelService.modelData)	
  const fileShareStore = await Promise.promisify(createFileShareStore)(froot, docStore) 
  const fileShareData = createFileShareData(modelData, fileShareStore)
  const fileShareService = createFileShareService(fileData, fileShareData)
  const fileService = new FileService(froot, fileData, fileShareData) 

	await modelService.initializeAsync()

	console.log('modelData', modelData.users, modelData.drives)

	if (process.env.FORK) {
		console.log('fruitmix started in forked mode')	

		process.send({ type: 'fruitmixStarted' })
		process.on('message', message => {
			switch (message.type) {
			case 'createFirstUser':
				break
			default:
				break	
			}
		})
	}
	else {
		console.log('fruitmix started in standalone mode')
	}

  await fileShareService.load()

  const ipc = config.ipc
  ipc.register('ipctest', (text, callback) => process.nextTick(() => callback(null, text.toUpperCase())))
  modelService.register(ipc) 
}

