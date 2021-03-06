import {Router, Request, Response} from 'express';
import {FeedItem} from '../models/FeedItem';
import {requireAuth} from '../../users/routes/auth.router';
import * as AWS from '../../../../aws';
import axios, {AxiosResponse} from 'axios';
import {config} from '../../../../config/config';

const url = require('url');

const router: Router = Router();

// Get all feed items
router.get('/', async (req: Request, res: Response) => {
    const items = await FeedItem.findAndCountAll({order: [['id', 'DESC']]});
    items.rows.map((item) => {
        if (item.url) {
            item.url = AWS.getGetSignedUrl(item.url);
        }
    });
    res.send(items);
});

// Get a signed url to put a new item in the bucket
router.get('/signed-url/:fileName',
    requireAuth,
    async (req: Request, res: Response) => {
        const {fileName} = req.params;

        if (!fileName) {
            return res.status(500).send({message: `fileName must not be empty`});
        }

        const putUrl = AWS.getPutSignedUrl(fileName);
        res.status(201).send({url: putUrl});
    });

// endpoint to GET a specific resource by Primary Key
router.get('/:id', async (req: Request, res: Response) => {
    const {id} = req.params;

    try {
        const item = await FeedItem.findByPk(id);
        if (item) {
            return res.status(200).send(item);
        }
        res.status(204).send();
    } catch (error) {
        res.status(500).send(error);
    }
});

// update a specific resource
router.patch('/:id',
    requireAuth,
    async (req: Request, res: Response) => {
        const id = req.params.id;
        if (!id) {
            return res.status(500).send({message: `No id given`});
        }

        try {
            const validatedBody = validateBody(req.body);
            const updatedItems = await FeedItem.update(validatedBody, {
                where: {id},
                returning: true
            });
            if (updatedItems[0] === 0) {
                return res.status(500).send({message: `No matching item for id ${id} found`});
            } else if (updatedItems[0] > 1) {
                return res.status(500).send({message: `more than one item for id ${id} found`});
            }

            const saved_item = updatedItems[1][0];
            saved_item.url = AWS.getGetSignedUrl(saved_item.url);
            res.status(201).send(saved_item);
        } catch (e) {
            const error: Error = e;
            res.status(500).send({message: error.message});
        }
    });


// Post meta data and the filename after a file is uploaded
// NOTE the file name is they key name in the s3 bucket.
// body : {caption: string, fileName: string};
router.post('/',
    requireAuth,
    async (req: Request, res: Response) => {
        try {
            const validatedBody = validateBody(req.body);
            const item = new FeedItem({
                caption: validatedBody.caption,
                url: validatedBody.url
            });
            const saved_item = await item.save();

            const itemGetURL = AWS.getGetSignedUrl(saved_item.url);

            if (validatedBody.transform) {
                await transformImage(itemGetURL, saved_item.url);
            }

            saved_item.url = itemGetURL;
            res.status(201).send(saved_item);
        } catch (e) {
            const error: Error = e;
            res.status(500).send({message: error.message});
        }
    }
);

interface TransformedBody {
    caption: string;
    url: string;
    transform: boolean;
}

function validateBody(input: any): TransformedBody {
    // check Caption is valid
    if (!input.caption) {
        throw Error('Caption is required or malformed');
    }

    // check Filename is valid
    if (!input.url) {
        throw Error('File url is required');
    }

    // check transform flag is present
    if (('transform' in input) === false) {
        throw Error('Transform flag is missing');
    }

    return {
        caption: input.caption,
        url: input.url,
        transform: input.transform
    };
}

async function transformImage(itemGetURL: string, originalURI: string): Promise<AxiosResponse> {
    // create URL for image transformation server
    const imageTransformURL = new URL('http://' + config.imageTransform.host);
    imageTransformURL.pathname = 'filteredimage';
    imageTransformURL.searchParams.append('image_url', itemGetURL);
    const imageTransformURLString = imageTransformURL.toString();

    // send image to transformation server
    const axiosResponse = await axios.get(imageTransformURLString, {
        responseType: 'arraybuffer'
    });

    // get S3 URL and send the transformed image there
    const itemPutURL = AWS.getPutSignedUrl(originalURI);
    return axios.put(itemPutURL, axiosResponse.data, {
        headers: {
            'content-type': axiosResponse.headers['content-type']
        }
    });
}

export const FeedRouter: Router = router;
