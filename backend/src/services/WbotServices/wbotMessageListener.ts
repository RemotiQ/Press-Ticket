/* eslint-disable no-plusplus */
/* eslint-disable no-nested-ternary */
import * as Sentry from "@sentry/node";
import { writeFile } from "fs";
import { join } from "path";
import { promisify } from "util";

import {
  Client,
  MessageAck,
  Contact as WbotContact,
  Message as WbotMessage
} from "whatsapp-web.js";

import ffmpeg from "fluent-ffmpeg";
import Contact from "../../models/Contact";
import Integration from "../../models/Integration";
import Message from "../../models/Message";
import OldMessage from "../../models/OldMessage";
import Settings from "../../models/Setting";
import Ticket from "../../models/Ticket";

import { debounce } from "../../helpers/Debounce";
import formatBody from "../../helpers/Mustache";
import { getIO } from "../../libs/socket";
import { logger } from "../../utils/logger";
import CreateContactService from "../ContactServices/CreateContactService";
import CreateOrUpdateContactService from "../ContactServices/CreateOrUpdateContactService";
import GetContactService from "../ContactServices/GetContactService";
import CreateMessageService from "../MessageServices/CreateMessageService";
import ListSettingsServiceOne from "../SettingServices/ListSettingsServiceOne";
import FindOrCreateTicketService from "../TicketServices/FindOrCreateTicketService";
import UpdateTicketService from "../TicketServices/UpdateTicketService";
import ShowWhatsAppService from "../WhatsappService/ShowWhatsAppService";

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

const request = require("request");

interface Session extends Client {
  id?: number;
}

const writeFileAsync = promisify(writeFile);

const verifyContact = async (msgContact: WbotContact): Promise<Contact> => {
  const contactData = {
    name: msgContact.name || msgContact.pushname || msgContact.id.user,
    number: msgContact.id.user,
    isGroup: msgContact.isGroup
  };

  const contact = CreateOrUpdateContactService(contactData);

  return contact;
};

const verifyQuotedMessage = async (
  msg: WbotMessage
): Promise<Message | null> => {
  if (!msg.hasQuotedMsg) return null;

  const wbotQuotedMsg = await msg.getQuotedMessage();

  const quotedMsg = await Message.findOne({
    where: { id: wbotQuotedMsg.id.id }
  });

  if (!quotedMsg) return null;

  return quotedMsg;
};

const verifyRevoked = async (msgBody?: string): Promise<void> => {
  await new Promise(r => setTimeout(r, 500));

  const io = getIO();

  if (msgBody === undefined) {
    return;
  }

  try {
    const message = await Message.findOne({
      where: {
        body: msgBody
      }
    });

    if (!message) {
      return;
    }

    if (message) {
      await Message.update(
        { isDeleted: true },
        {
          where: { id: message.id }
        }
      );

      const msgIsDeleted = await Message.findOne({
        where: {
          body: msgBody
        }
      });

      if (!msgIsDeleted) {
        return;
      }

      io.to(msgIsDeleted.ticketId.toString())
        .to("notification")
        .emit("appMessage", {
          action: "update",
          message: msgIsDeleted
        });
    }
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error Message Revoke. Err: ${err}`);
  }
};

const verifyMediaMessage = async (
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
): Promise<Message> => {
  const quotedMsg = await verifyQuotedMessage(msg);

  const media = await msg.downloadMedia();

  if (!media) {
    throw new Error("ERR_WAPP_DOWNLOAD_MEDIA");
  }

  if (!media.filename) {
    const ext = media.mimetype.split("/")[1].split(";")[0];
    const shortTime = new Date().getTime().toString().slice(-6);
    const sanitizedName = contact.name.replace(/[^a-zA-Z0-9_]/g, "_");
    media.filename = `${sanitizedName}_${shortTime}.${ext}`;
  } else {
    const originalFilename = media.filename ? `-${media.filename}` : "";
    const shortTime = new Date().getTime().toString().slice(-6);
    media.filename = `${shortTime}_${originalFilename}`;
  }

  try {
    await writeFileAsync(
      join(__dirname, "..", "..", "..", "public", media.filename),
      media.data,
      "base64"
    )
      .then(() => {
        const inputFile = `./public/${media.filename}`;
        let outputFile: string;

        if (inputFile.endsWith(".mpeg")) {
          outputFile = inputFile.replace(".mpeg", ".mp3");
        } else if (inputFile.endsWith(".ogg")) {
          outputFile = inputFile.replace(".ogg", ".mp3");
        } else {
          return;
        }

        return new Promise<void>((resolve, reject) => {
          ffmpeg(inputFile)
            .toFormat("mp3")
            .save(outputFile)
            .on("end", () => {
              resolve();
            })
            .on("error", (err: any) => {
              reject(err);
            });
        });
      })
      .then(() => {
        console.log("Conversão concluída!");
        // Aqui você pode fazer o que desejar com o arquivo MP3 convertido.
      })
      .catch(err => {
        console.error("Ocorreu um erro:", err);
        // Trate o erro de acordo com sua lógica de aplicativo.
      });
  } catch (err: any) {
    Sentry.captureException(err);
    logger.error(err);
  }

  let $tipoArquivo: string;

  switch (media.mimetype.split("/")[0]) {
    case "audio":
      $tipoArquivo = "🔉 Mensagem de audio";
      break;

    case "image":
      $tipoArquivo = "🖼️ Arquivo de imagem";
      break;

    case "video":
      $tipoArquivo = "🎬 Arquivo de vídeo";
      break;

    case "document":
      $tipoArquivo = "📘 Documento";
      break;

    case "application":
      $tipoArquivo = "📎 Arquivo";
      break;

    case "ciphertext":
      $tipoArquivo = "⚠️ Notificação";
      break;

    case "e2e_notification":
      $tipoArquivo = "⛔ Notificação";
      break;

    case "revoked":
      $tipoArquivo = "❌ Apagado";
      break;

    default:
      $tipoArquivo = "🤷‍♂️ Tipo Desconhecido";
      break;
  }

  let $strBody: string;

  if (msg.fromMe === true) {
    $strBody = msg.body;
  } else {
    $strBody = msg.body;
  }

  const messageData = {
    id: msg.id.id,
    ticketId: ticket.id,
    contactId: msg.fromMe ? undefined : contact.id,
    body: $strBody || media.filename,
    fromMe: msg.fromMe,
    read: msg.fromMe,
    mediaUrl: media.filename,
    mediaType: media.mimetype.split("/")[0],
    quotedMsgId: quotedMsg?.id,
    userId: ticket.userId
  };

  if (msg.fromMe === true) {
    await ticket.update({
      lastMessage: `🢅 ${$tipoArquivo}` || `🢅 ${$tipoArquivo}`
    });
  } else {
    await ticket.update({
      lastMessage: `🢇 ${$tipoArquivo}` || `🢇 ${$tipoArquivo}`
    });
  }
  const newMessage = await CreateMessageService({ messageData });

  return newMessage;
};

const getGeocode = async (
  latitude: number,
  longitude: number
): Promise<string> => {
  const apiKey = await Integration.findOne({
    where: { key: "apiMaps" }
  });

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${apiKey?.value}`;

  return new Promise((resolve, reject) => {
    request(url, { json: true }, (err: any, res: any, body: any) => {
      if (err) {
        reject(err);
      } else if (body.results && body.results.length > 0) {
        resolve(body.results[0].formatted_address);
      } else {
        resolve(`${latitude}, ${longitude}`);
      }
    });
  });
};

const prepareLocation = async (msg: WbotMessage): Promise<WbotMessage> => {
  const gmapsUrl = `https://maps.google.com/maps?q=${msg.location.latitude}%2C${msg.location.longitude}&z=17`;

  try {
    const address = await getGeocode(
      Number(msg.location.latitude),
      Number(msg.location.longitude)
    );

    msg.body = `data:image/png;base64,${msg.body}|${gmapsUrl}`;
    msg.body += `|${
      address || `${msg.location.latitude}, ${msg.location.longitude}`
    }`;
  } catch (error) {
    console.error("Erro ao preparar a localização:", error);
    msg.body += `|${msg.location.latitude}, ${msg.location.longitude}`;
  }

  return msg;
};

const verifyMessage = async (
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  if (msg.type === "location") msg = await prepareLocation(msg);

  const quotedMsg = await verifyQuotedMessage(msg);
  const messageData = {
    id: msg.id.id,
    ticketId: ticket.id,
    contactId: msg.fromMe ? undefined : contact.id,
    body: msg.body,
    fromMe: msg.fromMe,
    mediaType: msg.type,
    read: msg.fromMe,
    quotedMsgId: quotedMsg?.id,
    userId: ticket.userId
  };

  if (msg.type === "multi_vcard") {

    if (!msg.body || msg.body === "") {

      if (msg.vCards && Array.isArray(msg.vCards) && msg.vCards.length > 0) {
        const extractedContacts = [];

        const vcardLines = msg.vCards.join(',').split('\n');

        let currentName = '';
        let currentNumber = '';

        for (let i = 0; i < vcardLines.length; i++) {
          const line = vcardLines[i];

          const parts = line.split(':');

          if (parts.length >= 2) {
            const key = parts[0];
            const value = parts.slice(1).join(':');

            if (key === 'FN') {
              currentName = value.trim();
            } else if (key.includes('TEL') && value) {
              currentNumber = value.trim();

              if (currentName && currentNumber) {
                extractedContacts.push({
                  name: currentName,
                  number: currentNumber
                });
              }
            }
          }
        }

        const processedContacts = [];

        for (const contact of extractedContacts) {
          try {

            try {
              const cont = await CreateContactService({
                name: contact.name,
                number: contact.number.replace(/\D/g, "")
              });
              processedContacts.push({
                id: cont.id,
                name: cont.name,
                number: cont.number
              });
            } catch (error) {
              if (error.message === "ERR_DUPLICATED_CONTACT") {
                const cont = await GetContactService({
                  name: contact.name,
                  number: contact.number.replace(/\D/g, ""),
                  email: ""
                });
                processedContacts.push({
                  id: cont.id,
                  name: cont.name,
                  number: cont.number
                });
              } else {
                throw error;
              }
            }
          } catch (err) {
            console.error(`Error processing contact ${contact.name}:`, err);
          }
        }

        if (processedContacts.length > 0) {
          const jsonData = JSON.stringify(processedContacts);

          try {
            const testParse = JSON.parse(jsonData);

            messageData.body = jsonData;
            msg.body = messageData.body;
          } catch (jsonError) {
            console.error("Error parsing JSON:", jsonError);
            messageData.body = JSON.stringify([{
              id: 0,
              name: "Contato do vCard",
              number: "Número não disponível"
            }]);
            msg.body = messageData.body;
          }
        } else {
          messageData.body = JSON.stringify([{
            id: 0,
            name: "Contato do vCard",
            number: "Número não disponível"
          }]);
          msg.body = messageData.body;
        }
      } else {
        messageData.body = JSON.stringify([{
          id: 0,
          name: "Contato do vCard",
          number: "Número não disponível"
        }]);
        msg.body = messageData.body;
      }
    } else {
      try {
        const bodyObj = JSON.parse(msg.body);
        if (!Array.isArray(bodyObj)) {
          console.warn("multi_vcard body is not an array, converting to array");
          messageData.body = JSON.stringify([bodyObj]);
          msg.body = messageData.body;
        }
      } catch (error) {
        console.error("Error parsing existing multi_vcard body:", error);
        messageData.body = JSON.stringify([{
          id: 0,
          name: "Contato do vCard",
          number: "Número não disponível"
        }]);
        msg.body = messageData.body;
      }
    }
  }

  if (msg.fromMe === true) {
    await ticket.update({
      fromMe: msg.fromMe,
      lastMessage:
        msg.type === "location"
          ? "🢅 🌍 Localization - Ver no Google Maps"
          : `🢅 ${msg.body}`
    });
  } else {
    await ticket.update({
      lastMessage:
        msg.type === "location"
          ? "🢇 🌍 Localization - Ver no Google Maps"
          : `🢇 ${msg.body}`
    });
  }

  await CreateMessageService({ messageData });
};

let greetingCounts: { [contactId: string]: number } = {};
const greetingLimit = (5 * 2);
let resetGreetingCountTimeout: NodeJS.Timeout;

const resetGreetingCounts = () => {
  greetingCounts = {};
  console.log("Contadores de saudações resetados.");
};

const startGreetingCountResetTimer = () => {
  clearTimeout(resetGreetingCountTimeout);
  resetGreetingCountTimeout = setTimeout(resetGreetingCounts, 1800000); // 30 minutos
};

const verifyQueue = async (
  wbot: Session,
  msg: WbotMessage,
  ticket: Ticket,
  contact: Contact
) => {
  const { queues, greetingMessage, isDisplay } = await ShowWhatsAppService(
    wbot.id!
  );

  const queueLengthSetting = await ListSettingsServiceOne({ key: "queueLength" });
  const queueLength = queueLengthSetting?.value;
  const queueValue = queueLength === "enabled" ? 0 : 1;

  if (queues.length === queueValue) {
    await UpdateTicketService({
      ticketData: { queueId: queues[0].id },
      ticketId: ticket.id
    });

    const chat = await msg.getChat();
    await chat.sendStateTyping();

    const body = formatBody(`\u200e${queues[0].greetingMessage}`, ticket);

    const sentMessage = await wbot.sendMessage(
      `${contact.number}@c.us`,
      body
    );

    await verifyMessage(sentMessage, ticket, contact);

    return;
  }

  const selectedOption = msg.body;

  const choosenQueue = queues[+selectedOption - 1];

  if (choosenQueue) {
    const Hr = new Date();

    const hh: number = Hr.getHours() * 60 * 60;
    const mm: number = Hr.getMinutes() * 60;
    const hora = hh + mm;

    const inicio: string = choosenQueue.startWork;
    const hhinicio = Number(inicio.split(":")[0]) * 60 * 60;
    const mminicio = Number(inicio.split(":")[1]) * 60;
    const horainicio = hhinicio + mminicio;

    const termino: string = choosenQueue.endWork;
    const hhtermino = Number(termino.split(":")[0]) * 60 * 60;
    const mmtermino = Number(termino.split(":")[1]) * 60;
    const horatermino = hhtermino + mmtermino;

    if (hora < horainicio || hora > horatermino) {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
      const body = formatBody(`\u200e${choosenQueue.absenceMessage}`, ticket);
      const debouncedSentMessage = debounce(
        async () => {
          const sentMessage = await wbot.sendMessage(
            `${contact.number}@c.us`,
            body
          );
          verifyMessage(sentMessage, ticket, contact);
        },
        3000,
        ticket.id
      );

      debouncedSentMessage();
    } else {
      await UpdateTicketService({
        ticketData: { queueId: choosenQueue.id },
        ticketId: ticket.id
      });

      const chat = await msg.getChat();
      await chat.sendStateTyping();

      const body = formatBody(`\u200e${choosenQueue.greetingMessage}`, ticket);

      const debouncedSentMessage = debounce(
        async () => {
          const sentMessage = await wbot.sendMessage(
            `${contact.number}@c.us`,
            body
          );
          verifyMessage(sentMessage, ticket, contact);
        },
        3000,
        ticket.id
      );
      debouncedSentMessage();
    }
  } else {
    let options = "";

    const contactId = contact.id.toString();
    if (!greetingCounts[contactId]) {
      greetingCounts[contactId] = 0;
    }

    if (greetingCounts[contactId] < greetingLimit) {
      const chat = await msg.getChat();
      await chat.sendStateTyping();
      greetingCounts[contactId]++;
      console.log(`Contador de saudações para ${contactId}:`, greetingCounts[contactId]);
      startGreetingCountResetTimer();
    }

    queues.forEach((queue, index) => {
      if (queue.startWork && queue.endWork) {
        if (isDisplay) {
          options += `*${index + 1}* - ${queue.name} das ${queue.startWork
            } as ${queue.endWork}\n`;
        } else {
          options += `*${index + 1}* - ${queue.name}\n`;
        }
      } else {
        options += `*${index + 1}* - ${queue.name}\n`;
      }
    });

    if (queues.length >= 2) {
      if (greetingCounts[contactId] < greetingLimit) {
        const body = formatBody(`\u200e${greetingMessage}\n\n${options}`, ticket);

        const debouncedSentMessage = debounce(
          async () => {
            const sentMessage = await wbot.sendMessage(
              `${contact.number}@c.us`,
              body
            );
            verifyMessage(sentMessage, ticket, contact);
          },
          3000,
          ticket.id
        );

        debouncedSentMessage();
        greetingCounts[contactId]++;
        console.log(`Contador de saudações para ${contactId}:`, greetingCounts[contactId]);
        startGreetingCountResetTimer();
      } else {
        console.log(`Limite de saudações atingido para ${contactId}.`);
      }
    } else {
      await UpdateTicketService({
        ticketData: { queueId: queues[0].id },
        ticketId: ticket.id
      });

      const body = formatBody(`\u200e${greetingMessage}`, ticket);
      const body2 = formatBody(`\u200e${queues[0].greetingMessage}`, ticket);

      const debouncedSentMessage = debounce(
        async () => {
          const sentMessage = await wbot.sendMessage(
            `${contact.number}@c.us`,
            body
          );
          verifyMessage(sentMessage, ticket, contact);
        },
        3000,
        ticket.id
      );

      debouncedSentMessage();

      setTimeout(() => {
        const debouncedSecondMessage = debounce(
          async () => {
            const sentMessage = await wbot.sendMessage(
              `${contact.number}@c.us`,
              body2
            );
            verifyMessage(sentMessage, ticket, contact);
          },
          2000,
          ticket.id
        );

        debouncedSecondMessage();
      }, 5000);
    }

  }
};

const isValidMsg = (msg: WbotMessage): boolean => {
  if (msg.from === "status@broadcast") return false;
  if (
    msg.type === "chat" ||
    msg.type === "audio" ||
    msg.type === "ptt" ||
    msg.type === "video" ||
    msg.type === "image" ||
    msg.type === "location" ||
    msg.type === "document" ||
    msg.type === "vcard" ||
    msg.type === "call_log" ||
    msg.type === "poll_creation" ||
    msg.type === "multi_vcard" ||
    msg.type === "sticker" ||
    msg.type === "notification_template" ||
    msg.type !== "e2e_notification" || // Ignore Empty Messages Generated When Someone Changes His Account from Personal to Business or vice-versa
    msg.author !== null // Ignore Group Messages
  )
    return true;
  return false;
};

const handleMessage = async (
  msg: WbotMessage,
  wbot: Session
): Promise<void> => {
  if (!isValidMsg(msg)) {
    return;
  }

  const Integrationdb = await Integration.findOne({
    where: { key: "urlApiN8N" }
  });

  if (Integrationdb?.value) {
    const options = {
      method: "POST",
      url: Integrationdb?.value,
      headers: {
        "Content-Type": "application/json"
      },
      json: msg
    };
    try {
      await request(options); 
    } catch (error) {
      throw new Error(error);
    }
  }

  // IGNORAR MENSAGENS DE GRUPO
  const Settingdb = await Settings.findOne({
    where: { key: "CheckMsgIsGroup" }
  });
  if (Settingdb?.value === "enabled") {
    const chat = await msg.getChat();
    if (
      msg.type === "sticker" ||
      msg.type === "e2e_notification" ||
      msg.type === "notification_template" ||
      msg.from === "status@broadcast" ||
      // msg.author !== null ||
      chat.isGroup
    ) {
      return;
    }
  }
  // IGNORAR MENSAGENS DE GRUPO

  try {
    let msgContact: WbotContact;
    let groupContact: Contact | undefined;
    let userId;
    let queueId;

    if (msg.fromMe) {
      // messages sent automatically by wbot have a special character in front of it
      // if so, this message was already been stored in database;
      if (/\u200e/.test(msg.body[0])) return;

      // media messages sent from me from cell phone, first comes with "hasMedia = false" and type = "image/ptt/etc"
      // in this case, return and let this message be handled by "media_uploaded" event, when it will have "hasMedia = true"

      if (
        !msg.hasMedia &&
        msg.type !== "location" &&
        msg.type !== "chat" &&
        msg.type !== "vcard"
        && msg.type !== "multi_vcard"
      )
        return;

      msgContact = await wbot.getContactById(msg.to);
    } else {
      const listSettingsService = await ListSettingsServiceOne({ key: "call" });
      var callSetting = listSettingsService?.value;

      msgContact = await msg.getContact();
    }

    const chat = await msg.getChat();

    if (chat.isGroup) {
      let msgGroupContact;

      if (msg.fromMe) {
        msgGroupContact = await wbot.getContactById(msg.to);
      } else {
        msgGroupContact = await wbot.getContactById(msg.from);
      }

      groupContact = await verifyContact(msgGroupContact);
    }
    const whatsapp = await ShowWhatsAppService(wbot.id!);

    const unreadMessages = msg.fromMe ? 0 : chat.unreadCount;

    const contact = await verifyContact(msgContact);

    let ticket = await FindOrCreateTicketService(
      contact,
      wbot.id!,
      unreadMessages,
      queueId,
      userId,
      groupContact
    );

    if (
      unreadMessages === 0 &&
      whatsapp.farewellMessage &&
      formatBody(whatsapp.farewellMessage, ticket) === msg.body
    )
      return;

    ticket = await FindOrCreateTicketService(
      contact,
      wbot.id!,
      unreadMessages,
      userId,
      queueId,
      groupContact
    );

    if (msg.hasMedia) {
      await verifyMediaMessage(msg, ticket, contact);
    } else {
      await verifyMessage(msg, ticket, contact);
    }

    if (
      !ticket.queue &&
      !chat.isGroup &&
      !msg.fromMe &&
      !ticket.userId &&
      whatsapp.queues.length >= 1
    ) {
      await verifyQueue(wbot, msg, ticket, contact);
    }

    if (msg.type === "vcard") {
      try {
        const array = msg.body.split("\n");
        const obj = [];
        // eslint-disable-next-line no-shadow
        let contact = "";
        for (let index = 0; index < array.length; index++) {
          const v = array[index];
          const values = v.split(":");
          for (let ind = 0; ind < values.length; ind++) {
            if (values[ind].indexOf("+") !== -1) {
              obj.push({ number: values[ind] });
            }
            if (values[ind].indexOf("FN") !== -1) {
              contact = values[ind + 1];
            }
          }
        }
        // eslint-disable-next-line no-restricted-syntax
        for await (const ob of obj) {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const cont = await CreateContactService({
            name: contact,
            number: ob.number.replace(/\D/g, "")
          });
        }
      } catch (error) {
        console.log(error);
      }
    }

    if (msg.type === "multi_vcard") {
      try {
        if (!msg.vCards) {
          console.error("vCards data is undefined");
          msg.body = JSON.stringify([{
            id: 0,
            name: "Contato do vCard",
            number: "Número não disponível"
          }]);
          return;
        }

        if ((typeof msg.vCards === 'string' && (msg.vCards as string).trim() === '') ||
          (Array.isArray(msg.vCards) && msg.vCards.length === 0)) {
          console.error("vCards data is empty");
          msg.body = JSON.stringify([{
            id: 0,
            name: "Contato do vCard",
            number: "Número não disponível"
          }]);
          return;
        }

        const array = msg.vCards.toString().split("\n");

        let name = "";
        let number = "";
        const obj = [];
        const conts = [];

        for (let index = 0; index < array.length; index++) {
          const v = array[index];

          const values = v.split(":");

          for (let ind = 0; ind < values.length; ind++) {
            if (values[ind] && values[ind].indexOf("+") !== -1) {
              number = values[ind];
            }
            if (values[ind] && values[ind].indexOf("FN") !== -1 && values[ind + 1]) {
              name = values[ind + 1];
            }
            if (name !== "" && number !== "") {
              obj.push({
                name,
                number
              });
              name = "";
              number = "";
            }
          }
        }

        if (obj.length === 0) {
          console.warn("No contacts were extracted from vCard data");

          if (typeof msg.vCards === 'object') {
            console.info("vCards is an object, stringifying:", JSON.stringify(msg.vCards));
          }

          if (msg.vCards && typeof msg.vCards === 'object') {
            try {
              if (Array.isArray(msg.vCards)) {
                for (let i = 0; i < msg.vCards.length; i++) {
                  const vcard = msg.vCards[i];

                  if (typeof vcard === 'string') {
                    const vcardStr = vcard.toString();
                    const nameMatch = vcardStr.match(/FN:(.*?)\n/i);
                    const telMatch = vcardStr.match(/TEL[^:]*:(.*?)\n/i);

                    if (nameMatch || telMatch) {
                      obj.push({
                        name: nameMatch ? nameMatch[1].trim() : 'Sem nome',
                        number: telMatch ? telMatch[1].trim() : ''
                      });
                    }
                  }
                }
              } else {
                const vcardStr = String(msg.vCards);
                const vcardParts = vcardStr.split("BEGIN:VCARD");

                for (let i = 1; i < vcardParts.length; i++) {
                  const part = vcardParts[i];

                  const nameMatch = part.match(/FN:(.*?)\n/i);
                  const telMatch = part.match(/TEL[^:]*:(.*?)\n/i);

                  if (nameMatch || telMatch) {
                    obj.push({
                      name: nameMatch ? nameMatch[1].trim() : 'Sem nome',
                      number: telMatch ? telMatch[1].trim() : ''
                    });
                  }
                }
              }
            } catch (err) {
              console.error("Error processing vCards object:", err);
            }
          }
        }

        // eslint-disable-next-line no-restricted-syntax
        for await (const ob of obj) {
          try {
            const cont = await CreateContactService({
              name: ob.name,
              number: ob.number.replace(/\D/g, "")
            });
            conts.push({
              id: cont.id,
              name: cont.name,
              number: cont.number
            });
          } catch (error) {
            if (error.message === "ERR_DUPLICATED_CONTACT") {
              const cont = await GetContactService({
                name: ob.name,
                number: ob.number.replace(/\D/g, ""),
                email: ""
              });
              conts.push({
                id: cont.id,
                name: cont.name,
                number: cont.number
              });
            } else {
              console.error(`Error processing contact ${ob.name}:`, error);
            }
          }
        }

        if (conts.length > 0) {
          const validContacts = conts.map(contact => ({
            id: contact.id || 0,
            name: contact.name || "Contato",
            number: contact.number || "Número não disponível"
          }));

          const jsonData = JSON.stringify(validContacts);

          try {
            JSON.parse(jsonData);
          } catch (e) {
            console.error("JSON validation failed:", e);
          }

          msg.body = jsonData;
        } else {
          console.warn("No contacts were processed from multi_vcard");

          msg.body = JSON.stringify([{
            id: 0,
            name: "Contato do vCard",
            number: "Número não disponível"
          }]);
        }
      } catch (error) {
        console.error("Error processing multi_vcard:", error);
      }
    }

    // eslint-disable-next-line block-scoped-var
    if (msg.type === "call_log" && callSetting === "disabled") {
      const sentMessage = await wbot.sendMessage(
        `${contact.number}@c.us`,
        "*Mensagem Automática:*\nAs chamadas de voz e vídeo estão desabilitas para esse WhatsApp, favor enviar uma mensagem de texto. Obrigado"
      );
      await verifyMessage(sentMessage, ticket, contact);
    }
    const profilePicUrl = await msgContact.getProfilePicUrl();
    const contactData = {
      name: msgContact.name || msgContact.pushname || msgContact.id.user,
      number: msgContact.id.user,
      profilePicUrl,
      isGroup: msgContact.isGroup
    };
    await CreateOrUpdateContactService(contactData);
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error handling whatsapp message: Err: ${err}`);
  }
};

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
const handleMsgAck = async (msg: WbotMessage, ack: MessageAck) => {
  await new Promise(r => setTimeout(r, 500));

  const io = getIO();

  try {
    const messageToUpdate = await Message.findByPk(msg.id.id, {
      include: [
        "contact",
        {
          model: Message,
          as: "quotedMsg",
          include: ["contact"]
        },
        {
          model: OldMessage,
          as: "oldMessages"
        }
      ]
    });

    if (!messageToUpdate) {
      return;
    }

    const ackToUpdate = ack || 0;
    await messageToUpdate.update({ ack: ackToUpdate });

    io.to(messageToUpdate.ticketId.toString()).emit("appMessage", {
      action: "update",
      message: messageToUpdate
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error handling message ack. Err: ${err}`);
  }
};

const handleMsgEdit = async (
  msg: WbotMessage,
  newBody: string,
  oldBody: string
): Promise<void> => {
  let editedMsg = await Message.findByPk(msg.id.id, {
    include: [
      {
        model: OldMessage,
        as: "oldMessages"
      }
    ]
  });

  if (!editedMsg) return;

  const io = getIO();

  try {
    const messageData = {
      messageId: msg.id.id,
      body: oldBody
    };

    await OldMessage.upsert(messageData);
    await editedMsg.update({ body: newBody, isEdited: true });

    await editedMsg.reload();

    io.to(editedMsg.ticketId.toString()).emit("appMessage", {
      action: "update",
      message: editedMsg
    });
  } catch (err) {
    Sentry.captureException(err);
    logger.error(`Error handling message edit. Err: ${err}`);
  }
};

const wbotMessageListener = async (wbot: Session): Promise<void> => {
  wbot.on("message_create", async msg => {
    handleMessage(msg, wbot);
  });

  wbot.on("message_edit", async (msg, newBody, oldBody) => {
    handleMsgEdit(msg, newBody as string, oldBody as string);
  });

  wbot.on("media_uploaded", async msg => {
    handleMessage(msg, wbot);
  });

  wbot.on("message_ack", async (msg, ack) => {
    handleMsgAck(msg, ack);
  });

  wbot.on("message_revoke_everyone", async (after, before) => {
    const msgBody: string | undefined = before?.body;
    if (msgBody !== undefined) {
      verifyRevoked(msgBody || "");
    }
  });
};

export { handleMessage, handleMsgAck, wbotMessageListener };
