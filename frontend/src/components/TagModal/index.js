import {
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    InputAdornment,
    makeStyles,
    TextField
} from "@material-ui/core";
import { green } from "@material-ui/core/colors";
import { Colorize } from "@material-ui/icons";
import {
    Field,
    Form,
    Formik
} from "formik";
import { ColorBox } from 'material-ui-color';
import React, { useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "react-toastify";
import * as Yup from "yup";
import { AuthContext } from "../../context/Auth/AuthContext";
import toastError from "../../errors/toastError";
import api from "../../services/api";

const useStyles = makeStyles(theme => ({
    root: {
        display: "flex",
        flexWrap: "wrap",
    },
    multFieldLine: {
        display: "flex",
        "& > *:not(:last-child)": {
            marginRight: theme.spacing(1),
        },
    },
    btnWrapper: {
        position: "relative",
    },
    buttonProgress: {
        color: green[500],
        position: "absolute",
        top: "50%",
        left: "50%",
        marginTop: -12,
        marginLeft: -12,
    },
    formControl: {
        margin: theme.spacing(1),
        minWidth: 120,
    },
    colorAdorment: {
        width: 20,
        height: 20,
    },
}));

const TagSchema = Yup.object().shape({
    name: Yup.string()
        .min(3, "Mensagem muito curta")
        .required("Obrigatório")
});

const TagModal = ({ open, onClose, tagId, reload }) => {
    const classes = useStyles();
    const { t } = useTranslation();
    const { user } = useContext(AuthContext);
    const [colorPickerModalOpen, setColorPickerModalOpen] = useState(false);
    const initialState = {
        name: "",
        color: ""
    };
    const [tag, setTag] = useState(initialState);

    useEffect(() => {
        try {
            (async () => {
                if (!tagId) return;

                const { data } = await api.get(`/tags/${tagId}`);
                setTag(prevState => {
                    return { ...prevState, ...data };
                });
            })()
        } catch (err) {
            toastError(err);
        }
    }, [tagId, open]);

    const handleClose = () => {
        setTag(initialState);
        setColorPickerModalOpen(false);
        onClose();
    };

    const handleSaveTag = async values => {
        const tagData = { ...values, userId: user.id };
        try {
            if (tagId) {
                await api.put(`/tags/${tagId}`, tagData);
            } else {
                await api.post("/tags", tagData);
            }
            toast.success(t("tagModal.success"));
            if (typeof reload == 'function') {
                reload();
            }
        } catch (err) {
            toastError(err);
        }
        handleClose();
    };

    return (
        <div className={classes.root}>
            <Dialog
                open={open}
                onClose={handleClose}
                maxWidth="xs"
                fullWidth
                scroll="paper"
            >
                <DialogTitle id="form-dialog-title">
                    {(tagId ? `${t("tagModal.title.edit")}` : `${t("tagModal.title.add")}`)}
                </DialogTitle>
                <Formik
                    initialValues={tag}
                    enableReinitialize={true}
                    validationSchema={TagSchema}
                    onSubmit={(values, actions) => {
                        setTimeout(() => {
                            handleSaveTag(values);
                            actions.setSubmitting(false);
                        }, 400);
                    }}
                >
                    {({ touched, errors, isSubmitting, values }) => (
                        <Form>
                            <DialogContent dividers>
                                <div className={classes.multFieldLine}>
                                    <Field
                                        as={TextField}
                                        label={t("tagModal.form.name")}
                                        name="name"
                                        error={touched.name && Boolean(errors.name)}
                                        helperText={touched.name && errors.name}
                                        variant="outlined"
                                        margin="dense"
                                        onChange={(e) => setTag(prev => ({ ...prev, name: e.target.value }))}
                                        fullWidth
                                    />
                                </div>
                                <br />
                                <div className={classes.multFieldLine}>
                                    <Field
                                        as={TextField}
                                        fullWidth
                                        label={t("tagModal.form.color")}
                                        name="color"
                                        id="color"
                                        error={touched.color && Boolean(errors.color)}
                                        helperText={touched.color && errors.color}
                                        InputProps={{
                                            startAdornment: (
                                                <InputAdornment position="start">
                                                    <div
                                                        style={{ backgroundColor: values.color }}
                                                        className={classes.colorAdorment}
                                                    ></div>
                                                </InputAdornment>
                                            ),
                                            endAdornment: (
                                                <IconButton
                                                    size="small"
                                                    color="secondary"
                                                    onClick={() => setColorPickerModalOpen(!colorPickerModalOpen)}
                                                >
                                                    <Colorize />
                                                </IconButton>
                                            ),
                                        }}
                                        variant="outlined"
                                        margin="dense"
                                    />
                                </div>
                                {colorPickerModalOpen && (
                                    <div>
                                        <ColorBox
                                            disableAlpha={true}
                                            hslGradient={false}
                                            style={{ margin: '20px auto 0' }}
                                            value={tag.color}
                                            onChange={val => {
                                                setTag(prev => ({ ...prev, color: `#${val.hex}` }));
                                            }}
                                        />
                                    </div>
                                )}
                            </DialogContent>
                            <DialogActions>
                                <Button
                                    onClick={handleClose}
                                    color="secondary"
                                    disabled={isSubmitting}
                                    variant="outlined"
                                >
                                    {t("tagModal.buttons.cancel")}
                                </Button>
                                <Button
                                    type="submit"
                                    color="primary"
                                    disabled={isSubmitting}
                                    variant="contained"
                                    className={classes.btnWrapper}
                                >
                                    {tagId
                                        ? `${t("tagModal.buttons.okEdit")}`
                                        : `${t("tagModal.buttons.okAdd")}`}
                                    {isSubmitting && (
                                        <CircularProgress
                                            size={24}
                                            className={classes.buttonProgress}
                                        />
                                    )}
                                </Button>
                            </DialogActions>
                        </Form>
                    )}
                </Formik>
            </Dialog>
        </div>
    );
};

export default TagModal;