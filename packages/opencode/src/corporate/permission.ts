import { Permission } from "@/permission"

export namespace CorporatePermission {
  export function rules() {
    return Permission.fromConfig({
      "*": "deny",
      question: "allow",
      corp_status: "allow",
      corp_search: "allow",
      corp_list: "allow",
      corp_read: "allow",
      corp_note: "allow",
      corp_import_tree: "allow",
      corp_import_file: "allow",
      corp_source: "ask",
      memory_read: "allow",
      memory_search: "allow",
      memory_list: "allow",
      memory_write: "allow",
      memory_append: "allow",
    })
  }
}
