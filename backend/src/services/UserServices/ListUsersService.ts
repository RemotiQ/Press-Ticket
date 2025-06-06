import { Op, Sequelize } from "sequelize";
import Queue from "../../models/Queue";
import User from "../../models/User";
import Whatsapp from "../../models/Whatsapp";

interface Request {
  searchParam?: string;
  pageNumber?: string | number;
}

interface Response {
  users: User[];
  count: number;
  hasMore: boolean;
}

const ListUsersService = async ({
  searchParam = "",
  pageNumber = "1"
}: Request): Promise<Response> => {
  const whereCondition = {
    [Op.and]: [
      { profile: { [Op.ne]: "masteradmin" } },
      {
        [Op.or]: [
          {
            "$User.name$": Sequelize.where(
              Sequelize.fn("LOWER", Sequelize.col("User.name")),
              "LIKE",
              `%${searchParam.toLowerCase()}%`
            )
          },
          { email: { [Op.like]: `%${searchParam.toLowerCase()}%` } }
        ]
      }
    ]
  };
  const limit = 20;
  const offset = limit * (+pageNumber - 1);

  const { count, rows: users } = await User.findAndCountAll({
    where: whereCondition,
    attributes: [
      "name",
      "id",
      "online",
      "email",
      "profile",
      "isTricked",
      "createdAt",
      "startWork",
      "endWork",
      "active"
    ],
    limit,
    offset,
    order: [["createdAt", "DESC"]],
    include: [
      { model: Queue, as: "queues", attributes: ["id", "name", "color"] },
      {
        model: Whatsapp,
        as: "whatsapps",
        attributes: ["id", "name", "type", "color"]
      }
    ]
  });

  const hasMore = count > offset + users.length;

  return {
    users,
    count,
    hasMore
  };
};

export default ListUsersService;
