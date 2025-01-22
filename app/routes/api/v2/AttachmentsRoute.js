import { AttachmentsController } from '../../../controllers';

export default function addRoutes(app) {
  const controller = new AttachmentsController(app);

  app.get('/attachments/my', controller.my);
  app.get('/attachments/my/stats', controller.myStats);
  app.post('/attachments/my/sanitize', controller.mySanitize);
  app.get('/attachments/:attId', controller.getById);
  app.get('/attachments/:attId/:type', controller.getPreview);
}
